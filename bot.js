const Discord = require('discord.js');
const gm = require('gm');
const crypto = require('crypto');
const fs = require('fs');
const stream = require('stream');
const config = require("./config.json");
const cardFile=fs.readFileSync("all_cards.json");
const historyFile=fs.readFileSync("secret_all.json");
const request=require("request");
var winston=require('winston');
const logger = winston.createLogger({
	level: 'debug',
	transports: [
		new winston.transports.Console({format: winston.format.simple()}),
		new winston.transports.File({filename:'dombot.log'})
	],
	exitOnError: false,
});

var cardList=JSON.parse(cardFile);
var allHist=JSON.parse(historyFile);

const bot = new Discord.Client();

function nicify(inputName) {
  return inputName.trim().replace(/'|’/g,"").replace(/\s/g,"-").toLowerCase();
}

function splitLines(longString, maxChars) {
  var words=longString.replace(/(\n)/g,"$& ").split(" ");
  var lines=[]
  var line=''
  for(var i=0; i<words.length; i++) {
    if((line.length + words[i].length)>maxChars) {
	lines.push(line.replace(/\n/g,""));
    	line=words[i].replace(/'/g,"’")+ ' ';
    }
    else {
	if(line.indexOf("\n")>0) {
	  lines.push(line.replace(/\n/g,""));
    	  line=words[i].replace(/'/g,"’")+ ' ';
	} else {
    	  line+=words[i].replace(/'/g,"’")+' ';
	}
    }
  }
  // Add last line
  lines.push(line.replace(/\n/g,""));
  return lines;
}


bot.on('ready', function (evt) {
    logger.info('Connected');
    logger.info('Logged in as: ');
    logger.info(bot.username + ' - (' + bot.id + ')');
});
bot.on('message', message => {
    var prefix='!'
    var msg=message.content;

    // Display top 10 of leaderboard
    if(msg.startsWith(prefix+'leader')) {
      if(msg.indexOf('live')>0) {
	var scavengerURL="http://dominion.lauxnet.com/load_live_leaderboard";
	var mode="live"
      } else {
	var scavengerURL="http://dominion.lauxnet.com/load_leaderboard";
        var mode="stale"
	}
      logger.info('Scavenger URL: '+scavengerURL)
      request({url:scavengerURL, json:true}, function(err,response,leaderJSON) {
        if(!err && response.statusCode == 200) {
	  if(leaderJSON.leader_list.length>0) {
	    var leaderMsg="Shuffle iT Top 10"+((mode=='live')?" (live)":"")+"\n-------------------------\n"; 
	    for(i=0; i<10; i++) {
	    	leaderMsg+=leaderJSON.leader_list[i].level+"  "+leaderJSON.leader_list[i].name+"\n";
            }
	    message.channel.send("```"+leaderMsg+"```");
	    logger.info('Message: '+leaderMsg);
    }}})}
    // Display Currene glicko-2 rating for user
    if(msg.startsWith(prefix+'rating')) {
      const ratingShift=50;
      const ratingScale=7.5;
      var today=new Date().toISOString().slice(0,10);
      var shitUsername=msg.replace(prefix+'rating','').trim();
      logger.info('Username is: '+shitUsername);
      var scavengerURL="http://dominion.lauxnet.com/rating_history/?username="+encodeURIComponent(shitUsername)+"&date="+today;
      logger.info('Scavenger URL: '+scavengerURL)
      request({url:scavengerURL, json:true}, function(err,response,ratingJSON) {
        if(!err && response.statusCode == 200) {
	  if(ratingJSON.results.length>0) {
	    var rating=ratingShift+ratingScale*(ratingJSON.results[0].skill-2*ratingJSON.results[0].deviation)
	    var ratingMessage=shitUsername+": "+rating.toFixed(2)+" µ: "+ratingJSON.results[0].skill.toFixed(2)+" φ: "+ratingJSON.results[0].deviation.toFixed(2);
	    logger.info('Message: '+ratingMessage);
	    message.channel.send("```"+ratingMessage+"```");
	} // fail silently?
	}
	})
    }
    
    // Display secret history for given card
    if(msg.startsWith(prefix+'history')) {
    var lineWidth=59
    var imgWidth=480;

	if(nicify(msg.replace(prefix+'history',''))=='help') {
	  logger.info('Display help message');
	  helpMsg='This command displays some of Donald X’s design notes (aka "Secret History") for a given card or *card-shaped thing*.\n\nUsage: ```!history <card name>```Example:```!history Secret Chamber```\nTo conserve channel space, the text is rendered as an image. For some of the longer histories, you may need to open the image in your browser.';
	  message.channel.send(helpMsg);
	} else {
	logger.info('Secret history command invoked');
	var requestedCard=nicify(msg.replace(prefix+'history',''));
	logger.info('Requested card name (nice): '+requestedCard);
	var histArray=allHist.cards.filter(function(x){return x.nicename==requestedCard});
	logger.info('Length:'+histArray[0].history.length);

	if(histArray[0].history.length>4000) {
	  lineWidth=120;
	  imgWidth=900;
	}
		
	var histLines=splitLines(histArray[0].history,lineWidth);
	const passThrough = new stream.PassThrough();
	var headerSize=20;
	if(histArray[0].name.length>20) 
	  headerSize=18;
	var gmCommand="gm('images/parchment-min.jpg').font('Helvetica').fontSize('"+headerSize+"').resize("+imgWidth+","+(histLines.length*20+65)+",'!')";
	gmCommand+=".drawText(20,30,'Secret history of "+histArray[0].name+"').fontSize('16')";
	logger.info('History for: '+histArray[0].name);
	for(var i=0; i<histLines.length; i++) {
	  if(histLines[i].startsWith('    ')) {
            gmCommand+=".drawText(40,"+(20*i+60)+",'"+histLines[i]+"')";
	  } else if(histLines[i].startsWith('2nd Edition')) {
	    gmCommand+=".font('Helvetica-Bold').drawText(20,"+(20*i+60)+",'"+histLines[i]+"').font('Helvetica')";
	  } else {
            gmCommand+=".drawText(20,"+(20*i+60)+",'"+histLines[i]+"')";
	  }
	}
	gmCommand+=".stream('miff').pipe(passThrough);";
	logger.info(gmCommand);
	eval(gmCommand);
	gm(passThrough)
	.write('/tmp/'+requestedCard+'_history.png',function(err,stdout,stderr) {
		    if(!err) {
		    message.channel.send('', {files:["/tmp/"+requestedCard+"_history.png"]})
		    } else {
			logger.error(err);
			throw(err);
	}})}}
    // Display formatted kingdom image
    if(msg.startsWith(prefix+'kingdom')) {
    	const cardWidth=320 //grab this from image?
    	const cardHeight=304 // grab this from images?
    	const csoWidth=481 // ?
    	const padding=12
	var bane=''
	var baneIndex

        var kingdom = msg.replace(prefix+'kingdom','').split(",");
	for(var i=0; i<kingdom.length; i++) {
            kingdom[i]=nicify(kingdom[i]);
		logger.info(kingdom[i]);
	    if(kingdom[i].indexOf('(b)')>0) {
		kingdom[i]=kingdom[i].replace(/\(b\)/,"");
		kingdom[i]=kingdom[i].replace(/-$/,"");
		bane=kingdom[i]
		logger.info('Bane is '+kingdom[i]);
		}
	}	
	// Gather info from cards based on JSON card list
	var cardSupply=cardList.cards.filter(function(x){if(x.type != 'Event' && x.type != 'Landmark') return kingdom.includes(x.nicename)});
	var csoSupply=cardList.cards.filter(function(x){if(x.type == 'Event' || x.type == 'Landmark') return kingdom.includes(x.nicename)});

	// If we have 'Knight' in the set, AND no knight listed by name already, grab a random night
	if(kingdom.indexOf("knight") > -1 || kingdom.indexOf("knights") > -1) {
		logger.info('Knight requested!');
	  var knightsCount = cardSupply.filter(function(x) { return (x.nicename.startsWith('sir-')||x.nicename.startsWith('dame-'))}).length;
	  logger.info('Knights count: '+knightsCount);
	  if(knightsCount==0) {
	    knightsArray=cardList.cards.filter(function(x) { return (x.nicename.startsWith('sir-')||x.nicename.startsWith('dame-'))});
	    cardSupply.push(knightsArray[Math.floor(Math.random()*Math.floor(knightsArray.length-1))]);
	  }
	}

    // If we have a looter in the set, AND no ruins already, grab a random ruins?
	const looters = ["marauder","death-cart","cultist"]
     	var looterCount = cardSupply.filter(function(x) { return looters.includes(x.nicename)}).length;
	var ruinsCount = cardSupply.filter(function(x) { return x.type == 'Action-Ruins'}).length;
        logger.info('Looter array length: '+looterCount)
        logger.info('Ruins array length: '+ruinsCount)
    
     if(looterCount > 0 && ruinsCount==0) {
     	ruinsArray = cardList.cards.filter(function(x){return x.type=='Action-Ruins'});
     	cardSupply.push(ruinsArray[Math.floor(Math.random()*Math.floor(ruinsArray.length-1))]);
	ruinsCount++;
 	}
   
    
	const costSort = function(a,b) {
		if(a.cost.coins<0) a.cost.coins++;
		if(b.cost.cons<0) b.cost.coins++;
		if(a.cost.coins==b.cost.coins)
			if(a.cost.potion==b.cost.potion)
				return(a.cost.debt < b.cost.debt) ? -1 : (a.cost.debt > b.cost.debt) ? 1 : 0;
			else
				return(a.cost.potion < b.cost.potion) ? -1 : (a.cost.potion > b.cost.potion) ? 1 : 0;
		else
			return(a.cost.coins < b.cost.coins) ? -1 : (a.cost.coins > b.cost.coins) ? 1 : 0;};


	cardSupply.sort(costSort);
	csoSupply.sort(costSort);
	var kingdomFiles = [];
	var csoFiles = [];
        var filesFound = 0;

	// Need this to exempt bane/ruins
        if(cardSupply.length-ruinsCount<10) {
            message.channel.send("Need at least 10 kingdom cards");
            return;
        }

        for(var i=0; i<cardSupply.length; i++) {
            kingdomFiles[i] = "./images/cards/"+cardSupply[i].nicename+".jpg";
            if(fs.existsSync(kingdomFiles[i])) filesFound++;
            logger.info(kingdomFiles[i]);
        }
        for(var i=0; i<csoSupply.length; i++) {
            csoFiles[i] = "./images/cards/"+csoSupply[i].nicename+".jpg";
            if(fs.existsSync(csoFiles[i])) filesFound++;
            logger.info(csoFiles[i]);
        }

	// Check this count vs. original list?
        if(filesFound>=10) {
		logger.info('Found '+filesFound+' kingdom images');    
		var filename = crypto.createHash('md5').update(kingdomFiles.toString()).digest('hex');
		
		logger.info('Creating image file '+filename)
        // How do we handle Colony/PLatinum
        const passThrough = new stream.PassThrough();
        
	var colCount=Math.ceil(kingdomFiles.length/2)
	logger.info("Column count:"+colCount)
	// Generate graphicsmagick command
	var gmCommand = "gm()";
	for(var i=0; i<kingdomFiles.length;i++) {
		gmCommand = gmCommand + ".in('-page','+"+(i%colCount)*(padding+cardWidth)+"+"+(1-Math.floor(i/colCount))*(cardHeight+padding)+"').in('"+kingdomFiles[i]+"')"
		if(cardSupply[i].nicename==bane) {
			baneIndex=i;
			logger.info('Bane index is: '+baneIndex)
}				
}
	for(var i=0; i<csoFiles.length;i++) {
			gmCommand = gmCommand + ".in('-page','+"+i*(csoWidth+padding)+"+"+2*(padding+cardHeight)+"').in('"+csoFiles[i]+"')";
	}

	gmCommand = gmCommand + ".mosaic().background('transparent').stream('miff').pipe(passThrough);";
	logger.info(gmCommand);
	eval(gmCommand);
		gm(passThrough)
		.background('transparent')
		.fontSize('30')
		.font('TrajanPro-Bold.ttf')
		.draw('text +'+((baneIndex%colCount)*(padding+cardWidth)+110)+'+'+((1-Math.floor(baneIndex/colCount))*(cardHeight+padding)+290)+' BANE')
		.resize(800,null)
		.write('/tmp/'+filename+'.png',function(err,stdout,stderr) {
		    if(!err) {
		    message.channel.send('Your Kingdom:', {files:["/tmp/"+filename+".png"]})
		    } else {
			logger.error(err);
			throw(err);
			}
		});  
        }
        else {
            message.channel.send('Sorry! Some kingdom art not found');
        }
    }
})

bot.login(config.token);
