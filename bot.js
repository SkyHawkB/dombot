const Discord = require('discord.js');
const gm = require('gm');
const moment = require('moment');
const crypto = require('crypto');
const fs = require('fs');
const stream = require('stream');
const config = require('./config');
const tinygradient = require('tinygradient');
const historyFile=fs.readFileSync("secret_all.json");
const completeFile=fs.readFileSync("dominion.cards.json");
const request=require("request");
const winston=require('winston');
const async=require('async');
const vega=require('vega');
const LRU=require('lru-cache');
const glicko=require('./glicko');
const ratingTemplate=fs.readFileSync("vega-rating-template.json");
const logger = winston.createLogger({
    level: 'debug',
      transports: [
    new winston.transports.Console({format: winston.format.simple()}),
      new winston.transports.File({filename:'dombot.log'})
    ],
      exitOnError: false,
});
const sqlLogger = winston.createLogger({
    level: 'debug',
      transports: [
    new winston.transports.Console({format: winston.format.simple()}),
      new winston.transports.File({filename:'dombot-sql.log'})
    ],
      exitOnError: false,
});


commandCounts = {'rating':0,'versus':0,
    'kingdom':0,
    'history':0,
    'results':0,
    'leader':0,
    'peers':0,
    'chart':0,
    'prior':0,
    'text':0,
    'stats':0,
    'match':0,
    'art':0};

// Connect to DB, setup pool
var dbInfo = config.shitdb.prod;
logger.info('Database is:'+dbInfo.database);
var knex = require('knex')({
    client: dbInfo.client,
    connection: {
        host : dbInfo.host,
    user : dbInfo.user,
    password : dbInfo.password,
    database : dbInfo.database}
});
knex.on('query',function(query) {
    sqlLogger.info(moment().format() + " Executed query: "+query.sql+" with bindings:"+query.bindings);
});

var ratingCache=LRU({max:2000,maxAge:30*1000*60}); // 30 minutes
var leaderCache=LRU({max:30000,maxAge:60*1000*60}); // 60 minutes
var gameCache=LRU({max:1000000,maxAge:1000*60*60*48}); // 2 days
var currentPeriod=0;

var allHist=JSON.parse(historyFile);
var fullInfo=JSON.parse(completeFile);
var ratingGradient=tinygradient('red','white','green');

const bot = new Discord.Client();
const ratingStartDate = new Date('01-JAN-2017');

function logCommand(command) {
    commandCounts[command]++;
    logger.info('Command !'+command+' called '+commandCounts[command]+' times.');
}

function periodToDate(startDate, period) {
    var tempDate=new Date(startDate);
    tempDate.setDate(tempDate.getDate()+(period-1));
    return tempDate;
}

function nicify(inputName) {
    return inputName.trim().replace(/'|’/g,"").replace(/\s/g,"-").replace(/_/g,"-").toLowerCase();
}

function mapWinColor(p) {
    var color;
    if(p>1 || p<0) {
        color=0x000000;
    } else {
        if(p>0.5) {
            color=Math.floor((p-0.5)/(0.5)*255)*256;
        } else {
            color=Math.floor(((0.5-p)/0.5)*255)*256*256;
        }
    }
    return color;
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
    lines.push(line.replace(/\n/g,""));
    return lines;
}

function getKingdom(err, kingdomStr, drawCallback, msgCallback) {
    if(!err) {
        var mode='csv';
        var gameId;

        logger.info('Kingdom string is: '+kingdomStr);
        var kingdom;
        if(!isNaN(kingdomStr)) {
            mode='gameid';
            gameId=kingdomStr;
        } else {
            logger.info('User-supplied kingdom list');
            var kingdom = kingdomStr.split(",");
        }

        if(mode=='gameid') {
            logger.info('Game ID:'+gameId);
            knex.from('gameresults')
                .where('gameid','=',gameId)
                .first('pregame','gameid','gameresult')
                .asCallback(function(err,row) {
                    if(err) drawCallback(err,kingdom,msgCallback)
                    else {
                        if(row==undefined) {
                            drawCallback(new Error('Game not found'),kingdom,msgCallback);
                        } else {
                            logger.info(row.pregame);
                            var gameInfo=JSON.parse(row.pregame);
                            var gameResult=JSON.parse(row.gameresult);
                            var obeliskCard='';
                            for(player of gameResult.playerResults) {
                                for(part of player.score.parts) {
                                    if(part.cardObjectName=='OBELISK') {
                                        for(arg of part.explanation.arguments) {
                                            if(arg.argumentType=='SINGULAR_CARD') {
                                                obeliskCard=arg.argumentValue.cardObjectName;
                                            } 
                                        }
                                    }
                                }
                            }
                            kingdom=gameInfo.gameParameters.setupInstructions.kingdom;
                            var baneCard=gameInfo.gameParameters.setupInstructions.baneCard;
                            logger.info('Bane: '+baneCard);
                            logger.info('Obelisk: '+obeliskCard);
                            kingdom[kingdom.indexOf(baneCard)]+='(b)';
                            kingdom[kingdom.indexOf(obeliskCard)]+='(o)';
                            var colony=gameInfo.gameParameters.setupInstructions.usesColonies;
                            logger.info('Colony: '+colony);
                            if (colony) {
                                kingdom.push('COLONY');
                                kingdom.push('PLATINUM');
                            }
                            logger.info('Kingdom: '+kingdom);
                            logger.info('Kingdom count: '+kingdom.length);
                            drawCallback(null,kingdom,msgCallback);
                        }         
                    }})
        } else drawCallback(null,kingdom,msgCallback); 
    } else drawCallback(err,kingdom,msgCallback);
}

function drawKingdom(err, kingdom, msgCallback) {
    if(!err) {
        const cardWidth=320; //grab this from image?
        const cardHeight=304; // grab this from images?
        const csoWidth=481; // ?
        const padding=12;
        var bane= {
            name:'',
            X:0,
            Y:0,
            xnudge:0,
            type:'',
            textColor:'',
            index:-1,
            size:30,
            text:'BANE'
        };

        var obelisk={
            name:'',
            X:0,
            Y:0,
            xnudge:0,
            type:'',
            textColor:'',
            index:-1,
            size:30,
            text:'OBELISK'
        };

        logger.info('drawKingdom: Kingdom list:'+kingdom);
        for(var i=0; i<kingdom.length; i++) {
            kingdom[i]=nicify(kingdom[i]);
            logger.info(kingdom[i]);
            if(kingdom[i]=='castles')
                kingdom[i]='humble-castle';
            if(kingdom[i].indexOf('(b)')>0) {
                bane.index=i;
            }
            if(kingdom[i].indexOf('(o)')>0){
                obelisk.index=i;
            }
            if(bane.index==i) {
                kingdom[i]=kingdom[i].replace(/\(b\)/,"");
                kingdom[i]=kingdom[i].replace(/\(o\)/,"");
                kingdom[i]=kingdom[i].replace(/-$/,"");
                bane.name=kingdom[i];
                bane.type=fullInfo.filter(function(x){ return x.nicename==bane.name })[0].type;
                logger.info('Bane is '+bane.name);
                logger.info('Bane type is '+bane.type);
            }
            if(obelisk.index==i) {
                if(obelisk.index==bane.index) {
                    bane.text=bane.text+'/OBELISK';
                    bane.size=24;
                    bane.xnudge=-25;
                } else {
                    kingdom[i]=kingdom[i].replace(/\(o\)/,"");
                    kingdom[i]=kingdom[i].replace(/\(b\)/,"");
                    kingdom[i]=kingdom[i].replace(/-$/,"");
                    obelisk.name=kingdom[i];
                    obelisk.type=fullInfo.filter(function(x){ return x.nicename==obelisk.name })[0].type;
                    logger.info('Obelisk is '+obelisk.name);
                    logger.info('Obelisk type is '+obelisk.type);
                }
            }
        }	


        // Check for Colony and/or Platinum and remove them from list
        var platIndex=kingdom.indexOf('platinum');
        if(platIndex > -1) {
            logger.info('Removed platinum');
            kingdom.splice(platIndex,1);
        }
        var colonyIndex=kingdom.indexOf('colony');
        if(colonyIndex > -1) {
            logger.info('Removed colony');
            kingdom.splice(colonyIndex,1);
        }

        // Gather info from cards based on JSON card list
        var cardSupply=fullInfo.filter(function(x){if(x.type != 'Event' && x.type != 'Landmark' && x.type != 'Project') return kingdom.includes(x.nicename)});
        var csoSupply=fullInfo.filter(function(x){if(x.type == 'Event' || x.type == 'Landmark' || x.type == 'Project') return kingdom.includes(x.nicename)});
        // If we have 'Knight' in the set, AND no knight listed by name already, grab a random night
        if(kingdom.indexOf("knight") > -1 || kingdom.indexOf("knights") > -1) {
            logger.info('Knight requested!');
            var knightsCount = cardSupply.filter(function(x) { return (x.nicename.startsWith('sir-')||x.nicename.startsWith('dame-'))}).length;
            logger.info('Knights count: '+knightsCount);
            if(knightsCount==0) {
                knightsArray=fullInfo.filter(function(x) { return (x.nicename.startsWith('sir-')||x.nicename.startsWith('dame-'))});
                cardSupply.push(knightsArray[Math.floor(Math.random()*Math.floor(knightsArray.length-1))]);
            }
        }
        // If we have a looter in the set, AND no ruins already, grab a random ruins?
        const looters = ["marauder","death-cart","cultist"];
        var looterCount = cardSupply.filter(function(x) { return looters.includes(x.nicename)}).length;
        var ruinsCount = cardSupply.filter(function(x) { return x.type == 'Action-Ruins'}).length;
        logger.info('Looter array length: '+looterCount);
        logger.info('Ruins array length: '+ruinsCount);

        if(looterCount > 0 && ruinsCount==0) {
            ruinsArray = fullInfo.filter(function(x){return x.type=='Action-Ruins'});
            cardSupply.push(ruinsArray[Math.floor(Math.random()*Math.floor(ruinsArray.length-1))]);
            ruinsCount++;
        }

        const costSort = function(a,b) {
            if(a.cost.coins<0) a.cost.coins++;
            if(b.cost.cons<0) b.cost.coins++;
            if(a.cost.coins==b.cost.coins)
                if(a.cost.potion==b.cost.potion)
                    if(a.cost.debt==b.cost.debt) {
                        return(a.nicename<b.nicename) ? -1  : (a.nicename > b.nicename) ? 1 : 0;
                    } else
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

        logger.info("Card supply length: "+cardSupply.length);
        // Need this to exempt bane/ruins
        if(cardSupply.length-ruinsCount<10) {
            // implement error message 
            msgCallback(null,filename);
            logger.info("Need at least 10 kingdom cards");
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
        if(filesFound>=0) {
            logger.info('Found '+filesFound+' kingdom images');    
            var filename = crypto.createHash('md5').update(kingdomFiles.toString()).digest('hex');

            logger.info('Creating image file '+filename);
            const passThrough = new stream.PassThrough();

            var colCount=Math.ceil(kingdomFiles.length/2);
            logger.info("Column count:"+colCount);


            // Split into rows; row 1 goes on bottom, has fewer cards if odd
            row1=kingdomFiles.slice(0,Math.floor(kingdomFiles.length/2));
            row2=kingdomFiles.slice(Math.floor(kingdomFiles.length/2));

            if(colonyIndex > -1 || platIndex > -1) {
                row1.unshift("./images/cards/colony.jpg");
                row2.unshift("./images/cards/platinum.jpg");
            }
            // Generate graphicsmagick command
            var gmCommand = "gm()";
            for(var i=0; i<row1.length;i++) {
                //gmCommand = gmCommand + ".in('-page','+"+(i%colCount)*(padding+cardWidth)+"+"+(1-Math.floor(i/colCount))*(cardHeight+padding)+"').in('"+kingdomFiles[i]+"')";
                gmCommand = gmCommand + ".in('-page','+"+i*(padding+cardWidth)+"+"+(cardHeight+padding)+"').in('"+row1[i]+"')";
                if(row1[i]=="./images/cards/"+bane.name+".jpg") {
                    bane.X=i*(padding+cardWidth);
                    bane.Y=cardHeight+padding;
                    if(bane.type=='Night' || bane.type=='Night-Duration')
                        bane.textColor='white';
                    else
                        bane.textColor='black';
                    logger.info('Bane location: '+bane.X+','+bane.Y);
                }				
                if(row1[i]=="./images/cards/"+obelisk.name+".jpg") {
                    obelisk.X=i*(padding+cardWidth);
                    obelisk.Y=cardHeight+padding;
                    if(obelisk.type=='Night' || obelisk.type=='Night-Duration')
                        obelisk.textColor='white';
                    else
                        obelisk.textColor='black';
                    logger.info('Obelisk location: '+obelisk.X+','+obelisk.Y);
                }				
            }
            for(var i=0; i<row2.length;i++) {
                gmCommand = gmCommand + ".in('-page','+"+i*(padding+cardWidth)+"+0').in('"+row2[i]+"')";
                if(row2[i]=="./images/cards/"+bane.name+".jpg") {
                    bane.X=i*(padding+cardWidth);
                    bane.Y=0;
                    if(bane.type=='Night' || bane.type=='Night-Duration')
                        bane.textColor='white';
                    else
                        bane.textColor='black';
                    logger.info('Bane location: '+bane.X+','+bane.Y);
                }
                if(row2[i]=="./images/cards/"+obelisk.name+".jpg") {
                    obelisk.X=i*(padding+cardWidth);
                    obelisk.Y=0;
                    if(obelisk.type=='Night' || obelisk.type=='Night-Duration')
                        obelisk.textColor='white';
                    else
                        obelisk.textColor='black';
                    logger.info('Obelisk location: '+obelisk.X+','+obelisk.Y);
                }
            }

            //if(bane.name==obelisk.name) {
            //    bane.text=bane.text+"/OBELISK";
            //}

            for(var i=0; i<csoFiles.length;i++) {
                gmCommand = gmCommand + ".in('-page','+"+i*(csoWidth+padding)+"+"+2*(padding+cardHeight)+"').in('"+csoFiles[i]+"')";
            }
            // Handle this with a series of callbacks instead of eval?
            gmCommand = gmCommand + ".mosaic().background('transparent').stream('miff').pipe(passThrough);";
            logger.info(gmCommand);
            eval(gmCommand);
            gm(passThrough)
                .background('transparent')
                .fontSize(bane.size)
                .fill(bane.textColor)
                .font('TrajanPro-Bold.ttf')
                .draw('text +'+(bane.X+110+bane.xnudge)+'+'+(bane.Y+290)+' '+bane.text)
                .fontSize(obelisk.size)
                .fill(obelisk.textColor)
                .draw('text +'+(obelisk.X+110+obelisk.xnudge)+'+'+(obelisk.Y+290)+' '+obelisk.text)
                .resize(800,null)
                .write('/tmp/'+filename+'.png',function(err) {
                    if(!err) {
                        msgCallback(null,filename)
                    } else {
                        msgCallback(err,null);
                    }
                });  
        }
        else {
            // Create new error here?
            logger.info('Need 10 kingdom cards');
            msgCallback(null,null)
        }
    } else {
        msgCallback(err,null)
    }
}

bot.on('ready', function (evt) {
    bot.user.setActivity('type !help');
    logger.info('Connected '+moment().format());
    logger.info('Logged in as: '+bot.user.username + ' - (' + bot.user.id + ')');
        });
    bot.on('message', message => {
        var prefix='!'
        var msg=message.content;
    if(msg.startsWith(prefix+'help')) {
        message.channel.send({embed:{
            color: 3447003,
            title: 'Dominion Discord Bot Commands',
            fields:[{
                name:'Card info',
            value:'**!history** secret history for a card-shaped thing\n**!art** illustration for a card-shaped thing\n**!text** text for a card-shaped thing'},
            {name:'Shuffle iT info',
                value:'**!kingdom** generate kingdom image from game ID or CSV list\n**!rating** player rating\n**!leader** current leaderboard\n**!peers** players with similar rank\n**!chart** longitudinal rating chart\n**!versus** head-to-head results for two players\n**!results** unprocessed game results\n**!prior** summary of prior five games'},
            {name:'More info',
                value:'Each of these commands also works in a direct message to the bot.\nMore information for each command available by appending the word \'help\' to that command: e.g.```!kingdom help```'}]}});
    }
    if(msg.startsWith(prefix+'status')) {
        var commandText='';
        for(var cmd in commandCounts) {
            if(commandCounts.hasOwnProperty(cmd)){
                commandText+=cmd+': '+commandCounts[cmd]+"\n";
            }
        }
        message.channel.send({embed:{
            color: 3447003,
            title: "Dombot Status",
            fields:[{
                name:"Command Counts",
            value:commandText},
            {
                name:"Cache Sizes",
            value:"Leader cache: "+leaderCache.length+"\nRating cache: "+ratingCache.length+"\nGame cache:"+gameCache.length}]}});

    }
    if(msg.startsWith(prefix+'art')) {
        if(nicify(msg.replace(prefix+'art',''))=='help') {
            logger.info('Display help message for art');
            helpMsg='The "!art" command shows the original, frameless art for the specified card-shaped thing or set.\n\nExamples:```!art Expedition``````!art Page``````!art Dominion```';
            message.channel.send(helpMsg);
        } else {
            logCommand('art');
            var cardname=nicify(msg.replace(prefix+'art',''));
            logger.info('Looking for art for '+cardname);
            cardartFile = "./images/art/"+cardname+".jpg";

            var illustratorArray=fullInfo.filter(function(x) { return x.nicename==cardname});
            if(illustratorArray.length==0) {
                message.author.send("'"+cardname+"' is not a card I recognize.");
            } else {
                var illustrator=illustratorArray[0].artist;
                logger.info('Illustrator: '+illustrator);
                fs.access(cardartFile, fs.F_OK, (err) => {
                    if(err) {
                        logger.info('File not found: '+cardartFile);
                        message.author.send('No art found for '+cardname);
                    } else {
                        message.channel.send('*Illustrator: '+illustrator+'*', {files:[cardartFile]});
                        logger.info('Sent card art for: '+cardname);
                    }
                });
            }
        }
    }

    if(msg.startsWith(prefix+'match')) {
        if(nicify(msg.replace(prefix+'match',''))=='help') {
            logger.info('Display help message for match');
            helpMsg='The "!match" commands displays a brief summary of the previous 6 games (rated or unrated) between the two given players. This can be used, for example, to provide a summary of a recently played Dominion League match.\n\nExample:```!match Freaky,Cave-o-sapien```';
            message.channel.send(helpMsg);
        } else {
            logCommand('match');
            var users = msg.replace(prefix+'match','').split(",").map(function(x) {
                return x.trim();});
            logger.info('Looking up previous 6 games for '+users);
            var players=[];

            knex('users')
                .where('name',users[0])
                .first('id','name')
                .then(function(user1Row) {
                    if(!user1Row) {
                        message.author.send("No user found with name '"+users[0]+"'");
                        return null;
                    } else  {
                        console.log('Player 1 id: '+user1Row.id);
                        players.push({id:user1Row.id,name:user1Row.name,wins:0});
                        return knex('users').where('name',users[1]).first('id','name').then(function(user2Row) {
                            if(!user2Row) {
                                message.author.send("No user found with name '"+users[1]+"'");
                                return null;
                            } else  {
                                console.log('Player 2 id: '+user2Row.id);
                                players.push({id:user2Row.id,name:user2Row.name,wins:0});
                                var maxGameId;
                                if(gameCache.length>0) {
                                    maxGameId=Math.max.apply(null,gameCache.keys());
                                } else {
                                    maxGameId=0;
                                }
                                return knex('gameresults').whereNotNull('gameresult').orderBy('gameid','desc').first('gameid').then(function(gameIdRow) {
                                    if(!gameIdRow) {
                                        logger.info('Error finding max game id');
                                        return null;
                                    } else {
                                        return knex('gameresults').whereNotNull('gameresult').andWhere('gameid','>',Math.max(gameIdRow.gameid-30000,maxGameId-1000))
                                    .select('gameid','pregame','gameresult').then(function(rows) {
                                        if(rows.length>0) {
                                            for(row of rows) {
                                                if(!gameCache.has(row.gameid)) {
                                                    var gameInfo=JSON.parse(row.pregame);
                                                    var gameResults=JSON.parse(row.gameresult);

                                                    if(gameInfo && gameResults && gameResults.playerResults.length==2) {
                                                        var kingdom=gameInfo.gameParameters.setupInstructions.kingdom.map(function(x) {
                                                            return nicify(x);});
                                                        var kingdomCards=fullInfo.filter(function(x){return kingdom.includes(x.nicename)}).map(function(x) {
                                                            return x.name});
                                                        
                                                        delete gameResults.playerResults[0].ownedCards;
                                                        delete gameResults.playerResults[1].ownedCards;
                                                        delete gameResults.playerResults[0].score.parts;
                                                        delete gameResults.playerResults[1].score.parts;

                                                        gameCache.set(row.gameid,
                                                            {empty:gameResults.emptyPiles,
                                                               shelters:gameInfo.gameParameters.setupInstructions.usesShelters,
                                                               colony:gameInfo.gameParameters.setupInstructions.usesColonies,
                                                               bane:gameInfo.gameParameters.setupInstructions.baneCard,
                                                            kingdom:kingdomCards,
                                                            results:gameResults.playerResults,
                                                            players:gameInfo.playerIds});
                                                    }
                                                }
                                            }
                                        }
                                        var games=[];
                                        logger.info('Game cache size:'+gameCache.length);
                                        logger.info('About to go over each row of cache');
                                        gameCache.forEach(function(row,gameid,index) {
                                            if(games.length>10) {
                                                // Can we do this differently?
                                                //logger.info('Found 6 games, stopping');
                                                return;
                                            } else {
                                                    if(row.players.length==2) {
                                                        if((row.players[0].id==players[0].id && row.players[1].id==players[1].id) ||
                                                            (row.players[1].id==players[0].id && row.players[0].id==players[1].id)) {
                                                                if(row.results) {
                                                                    var endCondition='';
                                                                    console.log(row.empty)
                                                                    if(row.empty.length>0) {
                                                                        var emptyPilesNames=row.empty.map(function(x) {
                                                                            return nicify(x);});
                                                                        var emptyPiles=fullInfo.filter(function(x){return emptyPilesNames.includes(x.nicename)}).map(function(x) {
                                                                            return x.name}).join(', ');
                                                                    } else {
                                                                        var emptyPiles='';
                                                                    }
                                                                    if(row.empty.indexOf('KNIGHT_PILE')>-1)
                                                                        emptyPiles+=', Knights';
                                                                    if(row.empty.indexOf('RUIN_PILE')>-1)
                                                                        emptyPiles+=', Ruins';
                                                                    if(row.empty.indexOf('CASTLE_PILE')>-1)
                                                                        emptyPiles+=', Castles';

                                                                    var scoreSummary='';
                                                                    var totalTurns=0;
                                                                    row.results.sort(function(a,b) { 
                                                                        return(row.players.findIndex(x=>x.id==a.playerId.id) <
                                                                            row.players.findIndex(x=>x.id==b.playerId.id) ? -1 :1)});


                                                                    for(playerResult of row.results) {
                                                                        if(playerResult.resigned==0) {
                                                                            endCondition='Resigned';
                                                                        }
                                                                        scoreSummary+=playerResult.rank==1?'__':'';
                                                                        scoreSummary+=(players[0].id==playerResult.playerId.id)?players[0].name:players[1].name;
                                                                        scoreSummary+=playerResult.rank==1?'__':'';
                                                                        scoreSummary+=(playerResult.score.totalPoints<0)?': −':': ';
                                                                        //scoreSummary+=Math.abs(playerResult.score.totalPoints)+((playerResult.resigned==0)?' (resigned)':'');
                                                                        scoreSummary+=Math.abs(playerResult.score.totalPoints);
                                                                        scoreSummary+=', ';
                                                                        totalTurns+=playerResult.score.usedTurns;
                                                                    }
                                                                    if(totalTurns>2) {
                                                                        scoreSummary=scoreSummary.replace(/(, $)/g,'');
                                                                        logger.info('Score summary: '+scoreSummary);

                                                                        if(emptyPilesNames) {
                                                                            if(emptyPilesNames.indexOf('colony')>=0) {
                                                                                endCondition='Colonies';
                                                                            } else if(emptyPilesNames.indexOf('province')>=0) {
                                                                                endCondition='Provinces';
                                                                            } else if(emptyPilesNames.length>=3) {
                                                                                endCondition='3-pile';
                                                                            }
                                                                        }
                                                                        var winners=row.results.filter(function(x) {return x.rank==1}).map(function(x) {
                                                                            if(players[0].id==x.playerId.id) {
                                                                                return players[0].name;
                                                                            } else {
                                                                                if(players[1].id==x.playerId.id) {
                                                                                    return players[1].name;
                                                                                }
                                                                            } 
                                                                            return '';
                                                                        });
                                                                        if(winners.length>1) {
                                                                            games.push({gameid:gameid,score:scoreSummary,end:endCondition,winner:"Tie",kingdom:row.kingdom.join(', ')+(row.colony?'; Colony':'')+(row.shelters?'; Shelters':''),empty:emptyPiles,turns:(totalTurns%2==0)?(totalTurns/2).toFixed(0):(totalTurns/2).toFixed(1)});
                                                                            players[0].wins+=0.5;
                                                                            players[1].wins+=0.5;
                                                                        } else {
                                                                            games.push({gameid:gameid,score:scoreSummary,end:endCondition,winner:winners[0],kingdom:row.kingdom.join(', ')+(row.colony?'; Colony':'')+(row.shelters?'; Shelters':''),empty:emptyPiles,turns:(totalTurns%2==0)?(totalTurns/2).toFixed(0):(totalTurns/2).toFixed(1)});
                                                                            if(winners[0]==user1Row.name) {
                                                                                players[0].wins++;
                                                                            } else {
                                                                                players[1].wins++;
                                                                            }
                                                                        }
                                                                    }
                                                                }
                                                            }
                                                    }
                                                }
                                        })

                                        logger.info('Game Cache size:'+gameCache.length);
                                        var embedFields=[];
                                        games.sort(function(a,b) { return(a.gameid < b.gameid) ? -1 : (a.gameid > b.gameid) ? 1 : 0;});
                                        for(game of games) {
                                            embedFields.push({name:game.score+' ('+game.end+', '+game.turns+' turns)',value:'*'+game.gameid+'* — '+game.kingdom+((game.empty.length>0)?' — *Empty piles: '+game.empty+'*':'')});
                                        }

                                        message.channel.send({embed:{
                                            color: 3447003,
                                            //title: players[0].name +" v. "+players[1].name+' (click to submit)',
                                            title: players[0].name +" v. "+players[1].name,
                                            description: players[0].wins+"–"+players[1].wins,
                                            //url: 'https://docs.google.com/forms/d/e/1FAIpQLScwQkjJlnS8QX2Oi4x2AsoA-8CSQaSUmC_SDPDW4zpqhIA7NQ/formResponse?entry.843892210='+players[0].name+'&entry.1368919651='+players[0].wins+'&entry.589331394='+players[1].name+'&entry.1911195639='+players[1].wins+'&submit=Submit',
                                            //url: 'https://docs.google.com/forms/d/e/1FAIpQLScwQkjJlnS8QX2Oi4x2AsoA-8CSQaSUmC_SDPDW4zpqhIA7NQ/viewform?entry.843892210='+players[0].name+'&entry.1368919651='+players[0].wins+'&entry.589331394='+players[1].name+'&entry.1911195639='+players[1].wins,
                                            fields:embedFields}});
                                    }).catch((err) => {logger.error(err); throw err})
                                    }
                                }).catch((err) => { logger.error(err); throw err})
                            }
                        }).catch((err) => { logger.error(err); throw err})
                    }
                }).catch((err) => {logger.error(err); throw err})
        }
    }


    if(msg.startsWith(prefix+'prior')) {
        if(nicify(msg.replace(prefix+'prior',''))=='help') {
            logger.info('Display help message for previous');
            helpMsg='The "!prior" commands displays a brief summary of the previous 5 games for the indicated user, including game IDs and a comma-separated list of the kingdom cards (that can be pasted into the card selection window at Dominion Online).\n\nExample:```!prior crlundy```';
            message.channel.send(helpMsg);
        } else {
            logCommand('prior');
            var user = msg.replace(prefix+'prior','').trim();
            const ratingShift=50;
            const ratingScale=7.5;
            knex('users').where('name',user).first('id')
                .then(function(uidRow) {
                    if(!uidRow) {
                        message.author.send("No user found with that name.");
                        return null;
                    } else  {
                        return knex.from('ratingresults as rr')
                    .join('users as u2','rr.opponent','=','u2.id')
                    .join('users as u1','rr.user','=','u1.id')
                    .join('gameresults as gr','gr.gameid','=','rr.gameid')
                    .where('rr.ratingType', 0)
                    .andWhere('rr.user',uidRow.id)
                    .select('u1.name', 'u2.name as opponent','rr.gameid','rr.score','gr.gameid','gr.gameresult','gr.pregame')
                    .orderBy('gr.gameid','desc')
                    .limit(5)
                    .then(function(rows) {
                        if(rows.length>0) {
                            var paddingLength=rows.reduce(function(a,b) {return a.opponent.length > b.opponent.length ? a:b;}).opponent.length;
                            var prevMsg='';
                            var prevTitle='Recent games';
                            var games=[];
                            for(row of rows) {
                                var gameInfo=JSON.parse(row.pregame);
                                if(gameInfo) {
                                    kingdom=gameInfo.gameParameters.setupInstructions.kingdom.map(function(x) {
                                        return nicify(x);});
                                    kingdomCards=fullInfo.filter(function(x){return kingdom.includes(x.nicename)}).map(function(x) {
                                        return x.name});
                                }
                                var result=(row.score==1) ? 'W' : (row.score==0.5) ? 'D' : 'L';
                                games.push({gameid:row.gameid,opponent:row.opponent,result:result,kingdom:kingdomCards.join(', ')});
                                //prevMsg+="**"+row.gameid.toString().padStart(10)+'**\t'+row.opponent+'\t'+"("+result+")"+'\t'+kingdomCards.toString().substring(0,60)+'...\n';
                            } 
                            message.channel.send({embed:{
                                color: 3447003,
                                title: prevTitle,
                                //  description: prevMsg,
                                fields:[{
                                    name:games[0].gameid + " v. *"+games[0].opponent+" ("+games[0].result+")*",
                                value:games[0].kingdom},
                                {name:games[1].gameid + " v. *"+games[1].opponent+" ("+games[1].result+")*",
                                    value:games[1].kingdom},
                                {name:games[2].gameid + " v. *"+games[2].opponent+" ("+games[2].result+")*",
                                    value:games[2].kingdom},
                                {name:games[3].gameid + " v. *"+games[3].opponent+" ("+games[3].result+")*",
                                    value:games[3].kingdom},
                                {name:games[4].gameid + " v. *"+games[4].opponent+" ("+games[4].result+")*",
                                    value:games[4].kingdom}]}});
                        }
                        else  {
                            message.author.send("No games found.");
                        }
                    }).catch((err) => { logger.error( err); throw err })
                    }
                }).catch((err) => { logger.error(err); throw err })
        }
    }
    if(msg.startsWith(prefix+'previous')) {
        if(nicify(msg.replace(prefix+'previous',''))=='help') {
            logger.info('Display help message for previous');
            helpMsg='The "!previous" commands displays a brief summary of the previous 10 games, including game IDs.\n\nUsage: ```!previous <user>```\nExample:```!previous Cave-o-sapien```';
            message.channel.send(helpMsg);
        } else {
            var user = msg.replace(prefix+'previous','').trim();
            logger.info('Looking up unprocessed results for '+user);
            const ratingShift=50;
            const ratingScale=7.5;
            knex('users').where('name',user).first('id')
                .then(function(uidRow) {
                    if(!uidRow) {
                        message.author.send("No user found with that name.");
                        return null;
                    } else  {
                        return knex.from('ratingresults as rr')
                    .join('users as u2','rr.opponent','=','u2.id')
                    .join('users as u1','rr.user','=','u1.id')
                    .join('gameresults as gr','gr.gameid','=','rr.gameid')
                    .where('rr.ratingType', 0)
                    .andWhere('rr.user',uidRow.id)
                    //.andWhere('rr.processed',0)
                    .select('u1.name', 'u2.name as opponent','rr.gameid','rr.score','gr.gameid','gr.gameresult','gr.pregame')
                    .orderBy('gr.gameid','desc')
                    .limit(10)
                    .then(function(rows) {
                        if(rows.length>0) {
                            var paddingLength=rows.reduce(function(a,b) {return a.opponent.length > b.opponent.length ? a:b;}).opponent.length;
                            var prevMsg='```'+String('ID').padStart(10)+'\t'+String('Opponent').padStart(paddingLength)+'\tResult\tKingdom\n';
                            prevMsg+=String('—').repeat(10+6+43+paddingLength+(4*3))+'\n';
                            //     var prevTitle='Recent games';
                            //     var prevMsg='';
                            for(row of rows) {
                                var gameInfo=JSON.parse(row.pregame);
                                if(gameInfo) {
                                    kingdom=gameInfo.gameParameters.setupInstructions.kingdom.map(function(x) {
                                        return nicify(x);});
                                    kingdomCards=fullInfo.filter(function(x){return kingdom.includes(x.nicename)}).map(function(x) {
                                        return x.name});
                                }
                                var result=(row.score==1) ? 'W' : (row.score==0.5) ? 'D' : 'L';
                                prevMsg+=row.gameid.toString().padStart(10)+'\t'+row.opponent.padStart(paddingLength)+'\t'+result.padStart(6)+'\t'+kingdomCards.toString().substring(0,40)+'...\n';
                                //prevMsg+=row.gameid.toString().padStart(10)+'\t'+row.opponent+'\t'+"("+result+")"+'\t'+kingdomCards.toString().substring(0,40)+'...\n';
                            } 
                            prevMsg+='```';
                            message.channel.send(prevMsg);
                            //       message.channel.send({embed:{
                            //         color: 0xFFFFFF,
                            //         title: prevTitle,
                            //         description: prevMsg,
                            //            }});
                        }
                        else  {
                            message.author.send("No games found.");
                        }
                    }).catch((err) => { logger.error( err); throw err })
                    }
                }).catch((err) => { logger.error(err); throw err })
        }
    }

    if(msg.startsWith(prefix+'text')) {
        if(nicify(msg.replace(prefix+'text',''))=='help') {
            logger.info('Display help message for text');
            helpMsg='The "!text" command displays the basic information and instructions found on the specified card-shaped thing. The bar is colored according to type (i.e. Card, Project, Event, Boon etc.).\n\nExamples:```!text Expedition``````!text Page```';
            message.channel.send(helpMsg);
        } else {
            logCommand('text');
            var cardname=nicify(msg.replace(prefix+'text',''));
            var info=fullInfo.filter(function(x) { return x.nicename==cardname})[0];
            var cardText=info.text.replace("''(","*").replace(")''","*");
            var color='14342874';
            switch(info.type) {
                case 'Project':
                    color='14720397';
                    break;
                case 'Landmark':
                    color='4289797';
                    break;
                case 'Event':
                    color='10197915';
                    break;
                case 'Hex':
                    color='12807124';
                    break;
                case 'Boon':
                    color='16774256';
                    break;
                case 'State':
                    color='1';
                    break;
                case 'Artifact':
                    color='9131818';
                    break;
                default:
                    color='14342874';
            }
            if(info) {
                if(cardText.indexOf("---")>0) {
                    var aboveLine=cardText.split("---")[0];
                    var belowLine=cardText.split("---")[1];
                    message.channel.send({embed:{   
                        color: color,
                        title: info.name,
                        //description: "*"+info.type+"*\n"+aboveLine,
                        description: aboveLine,
                        fields:[{name:"__                          __",value:belowLine}]}});
                    //fields:[{name:"———————————————————",value:belowLine}]}});
        } else  {
            message.channel.send({embed:{   
                color: color,
                title: info.name,
                // description: "*"+info.type+"*\n"+info.text}});
                description: cardText}});
    }
//Name: '+info.name+'\n'+info.text);
logger.info('Sent card text for: '+cardname);
}
}
}

// markus stats 
if(msg.startsWith(prefix+'stats')) {
    if(nicify(msg.replace(prefix+'stats',''))=='help') {
        logger.info('Display help message for stats');
        helpMsg='The "!stats" command shows the "markus stats" for the named card or card-shaped thing.\n\nExamples:```!stats Expedition``````!stats Page```';
        message.channel.send(helpMsg);
    } else {
        logCommand('stats');
        var cardname=nicify(msg.replace(prefix+'stats',''));
        logger.info('Looking for stats for '+cardname);
        var statsFile = "./images/markus_stats/"+cardname+".png";

        fs.access(statsFile,fs.F_OK, (err) => {
            if(err) {
                message.author.send('Stats file not found for ' + cardname);
            } else {
                message.channel.send('', {files:[statsFile]});
                logger.info('Sent stats image for: '+cardname);
            }
        });
    }
}

if(msg.startsWith(prefix+'results')) {
    if(nicify(msg.replace(prefix+'results',''))=='help') {
        logger.info('Display help message for results');
        helpMsg='The "!results" command lists the current, unprocessed 2-player results for the given player and an estimate of what that player\'s new µ, φ and rating will be based on those results. The color bar indicates the performance of the player relative to expectation, from red (underperformed) to green (overperformed).\n\nExample:```!results Freaky```';
        message.channel.send(helpMsg);
    } else {
        logCommand('results');
        var user = msg.replace(prefix+'results','').trim();
        logger.info('Looking up unprocessed results for '+user);
        const ratingShift=50;
        const ratingScale=7.5;

        knex('users').where('name',user).first('id')
            .then(function(uidRow) {
                if(!uidRow) {
                    message.author.send('No user found by that name');
                } else {
                    return knex('ratinghistory').where('user','=',uidRow.id).max({period:'period'}).first('user').groupBy('user')
                .then(function(ratingRow) {
                    if(!ratingRow) {
                        message.author.send("No rating history found for that user."); 
                        return null; 
                    } else  {
                        return knex.from('ratinghistory as rh')
                    .join('users as u','u.id','=','rh.user')
                    .where('rh.user',uidRow.id)
                    .andWhere('period',ratingRow.period)
                    .andWhere('ratingType',0)
                    .first('u.name','rh.*')
                    .then(function(currentRatingRow) {
                        if(!currentRatingRow) {
                            message.author.send('No rating history found for that user.'); 
                        } else {
                            knex.from('ratingresults as rr')
                        .join('users as u2','rr.opponent','=','u2.id')
                        .join('users as u1','rr.user','=','u1.id')
                        .join('ratinghistory as rhu','rhu.user','=','rr.user')
                        .joinRaw('left outer join ratinghistory as rho on rr.opponent = rho.user and rho.ratingType=0 and rho.period='+ratingRow.period)
                        .where('rr.ratingType', 0)
                        .andWhere('rr.user',ratingRow.user)
                        .andWhere('rhu.ratingType',0)
                        .andWhereNot('u2.status',9)
                        .andWhere(function() {this.where('rr.processed',0).orWhere('rr.processed','>',ratingRow.period)})
                        .andWhere('rhu.period',ratingRow.period)
                        .select('u1.name', 'u2.name as opponent','rr.gameid','rr.score','rho.skill as opp_mu','rho.deviation as opp_phi','rhu.volatility as user_sigma','rhu.skill as user_mu','rhu.deviation as user_phi')
                        .then(function(rows) {
                            var userMu=currentRatingRow.skill;
                            var userPhi=currentRatingRow.deviation;
                            var userSigma=currentRatingRow.volatility;
                            if(rows.length>0) {
                                //var userMu=rows[0].user_mu;
                                //var userPhi=rows[0].user_phi;
                                //var userSigma=rows[0].user_sigma;
                                var resultsArray=[]; 
                                for(row of rows) {
                                    if(row.opp_mu == null) row.opp_mu = 0;
                                    if(row.opp_phi == null) row.opp_phi = 2;
                                    resultsArray.push({win:row.score,mu:row.opp_mu,phi:row.opp_phi});
                                } 

                                var newRating=glicko.update(userMu,userPhi,userSigma,0.4,resultsArray);
                                var winSummary=glicko.expectedWins(userMu,resultsArray);
                                var title='Won '+winSummary.wins+'/'+winSummary.played+', expected: '+winSummary.expected.toFixed(2)+'\n';
                                var currentMsg=(ratingScale*(userMu-2*userPhi)+ratingShift).toFixed(2)+'\tµ: '+userMu.toFixed(2).padStart(5)+'\tφ: '+userPhi.toFixed(3)+'\n'; 
                                var newMsg=(ratingScale*(newRating.mu-2*newRating.phi)+ratingShift).toFixed(2)+'\tµ: '+newRating.mu.toFixed(2).padStart(5)+'\tφ: '+newRating.phi.toFixed(3);
                                var performance=Math.max(Math.min(winSummary.wins-winSummary.expected,2),-2)/4 + 0.5;
                                var winColor=parseInt(ratingGradient.rgbAt(performance).toHex(),16);
                            } else  {
                                var resultsArray=[];
                                var userMu=currentRatingRow.skill;
                                var userPhi=currentRatingRow.deviation;
                                var userSigma=currentRatingRow.volatility;
                                var newRating=glicko.update(userMu,userPhi,userSigma,0.4,resultsArray);
                                var title='0 games played\n';
                                var currentMsg=(ratingScale*(userMu-2*userPhi)+ratingShift).toFixed(2)+'\tµ: '+userMu.toFixed(2).padStart(5)+'\tφ: '+userPhi.toFixed(3)+'\n'; 
                                var newMsg=(ratingScale*(newRating.mu-2*newRating.phi)+ratingShift).toFixed(2)+'\tµ: '+newRating.mu.toFixed(2).padStart(5)+'\tφ: '+newRating.phi.toFixed(3);
                                var winColor=0x000000;
                            }
                            message.channel.send({embed:{
                                color: winColor,
                                title: title,
                                description: resultMsg,
                                fields:[{
                                    name:"Current",
                                value:currentMsg},
                                {name:"New",
                                    value:newMsg}]}});
                        }).catch((err) => {logger.error(err); throw err })
                        }
                    }).catch((err) => { logger.error( err); throw err })
                    }
                }).catch((err) => { logger.error( err); throw err })
                }
            }).catch((err) => { logger.error(err); throw err })
    }
}

if(msg.startsWith(prefix+'chart')) {
    if(nicify(msg.replace(prefix+'chart',''))=='help') {
        logger.info('Display help message for chart');
        helpMsg='The "!chart" command displays a line graph of the given player\'s skill (µ) and rating over time.\n\nExample:```!chart Cave-o-sapien```';
        message.channel.send(helpMsg);
    } else {
        var user = msg.replace(prefix+'chart','').trim();
        // Change to allow user to go back X periods?
        const ratingShift=50;
        const ratingScale=7.5;
        logger.info('Generating rating chart for '+user);
        knex.from('users')
            .where('name',user)
            .first('id')
            .then(function(uidRow) {
                if(!uidRow) {
                    message.author.send("No user found with name '"+user+"'");
                    return null;
                } else  {
                    return knex.from('ratinghistory')
                .where('ratingType',0)
                .andWhere('user',uidRow.id)
                .max('period as max')
                .then(function(periodRow) {
                    if(!periodRow) {
                        message.author.send("No data found");
                        return null;
                    } else {
                        logger.info(periodRow);
                        var startPeriod=periodRow[0].max-180;
                        logger.info('Start period is:'+startPeriod);
                        return knex.from('ratinghistory as rh')
                    .join('users as u','u.id','=','rh.user')
                    .where('rh.user', uidRow.id)
                    .andWhere('rh.ratingType', 0)
                    .andWhere('rh.period','>',startPeriod)
                    .orderBy('rh.period','desc')
                    .select('u.name', 'rh.*')
                    .then(function(rows) {
                        if(rows.length>0) {
                            var ratingChart=JSON.parse(ratingTemplate);
                            ratingChart.title.text+=user;
                            var ratingArray=[];
                            for(row of rows) {
                                var ratingCalc=ratingShift+ratingScale*(row.skill-2*row.deviation);
                                var periodDate=periodToDate(ratingStartDate,row.period);
                                ratingArray.push({period:periodDate,rating:ratingCalc,type:'rating'});
                                ratingArray.push({period:periodDate,rating:row.skill*ratingScale+ratingShift,type:'skill'});
                            } 
                            ratingChart.data.push({name:'ratings',values:ratingArray});

                            var view = new vega.View(vega.parse(ratingChart))
                        .renderer('none')
                        .initialize();

                    view.toCanvas()
                        .then(function(canvas) {
                            fs.writeFile('/tmp/'+user+'_rating.png', canvas.toBuffer(),function(err) {
                                if(!err) {
                                    message.channel.send('',{files:['/tmp/'+user+'_rating.png']});
                                } else {
                                    logger.info('Error writing chart file for user '+user);
                                } 
                            })
                        })
                    .catch(function(err) { console.error(err); });
                        } else  {
                            message.author.send("No data found");
                        }
                    }).catch((err) => { logger.error( err); throw err })
                    }
                }).catch((err) => { logger.error( err); throw err })
                }
            }).catch((err) => { logger.error( err); throw err })
    }
}

if(msg.startsWith(prefix+'rating')) {
    if(nicify(msg.replace(prefix+'rating',''))=='help') {
        logger.info('Display help message');
        helpMsg='The "!rating" command displays the rating, skill (µ) and deviation (φ) of a given user or comma-separated list of users.\n\nExamples:```!rating Cave-o-sapien``````!rating Stef,tracer,RTT```';
        message.channel.send(helpMsg);
    } else {
        logCommand('rating');
        var users = msg.replace(prefix+'rating','').split(",").map(function(x) {
            return x.trim();});

        const ratingShift=50;
        const ratingScale=7.5;
        logger.info('Looking up rating for '+users);

        // Check rating cache for each user
        var missingCount=0;
        for(user of users) {
            if(!ratingCache.has(nicify(user)))
                missingCount++;
        }
        logger.info('Missing rating count:'+missingCount);

        if(missingCount > 0) {
            logger.info('Pulling ratings from database');
            logger.info('Cache size: '+ratingCache.length);
            knex.on('query',function(query) {
                sqlLogger.info(moment().format() + " Executed query: "+query.sql+" with bindings:"+query.bindings);
            });
            var ratingQ = knex('ratinghistory').where('ratingType',0).max('period');
            knex.from('ratinghistory')
                .join('users','users.id','=','ratinghistory.user')
                .whereIn('name', users)
                .andWhere('ratingType', 0)
                .andWhere('period',ratingQ)
                .select('users.name', 'ratinghistory.*').orderByRaw('7.5*(skill-2*deviation) desc').then(function(rows) {
                    if(rows.length>0) {
                        logger.info('Found '+rows.length+' rows.');
                        var resultMsg='';
                        var paddingLength=rows.reduce(function(a,b) {return a.name.length > b.name.length ? a:b;}).name.length;
                        logger.info('Padding length: '+paddingLength);
                        for(row of rows) {
                            if(row.period>currentPeriod) {
                                logger.info('Updating current period from' +currentPeriod+' to ' +row.period);
                                logger.info('Resetting cache.');
                                currentPeriod=row.period;
                                ratingCache.reset();
                            }
                            ratingCache.set(nicify(row.name),row);
                            logger.info(row.name + " " +row.skill+ " " +row.period);
                            var rating=ratingShift+ratingScale*(row.skill-2*row.deviation);
                            resultMsg+=row.name.padStart(paddingLength,' ')+": "+rating.toFixed(2)+"\tµ: "+row.skill.toFixed(2).padStart(5)+"\tφ: "+row.deviation.toFixed(2)+"\n";
                        } 
                        logger.info('Results message:'+resultMsg);
                        message.channel.send("```"+resultMsg+"```");
                    } else  {
                        // fail silently or return message?
                        message.author.send("No data found");
                    }
                }).catch((err) => { logger.error( err); throw err })
        } else {
            logger.info('Pulling rating from cache');
            logger.info('Cache size: '+ratingCache.length);
            var resultMsg='';
            var paddingLength=users.reduce(function(a,b) {return a.length>b.length ? a:b;}).length;
            logger.info('Padding length: '+paddingLength);
            var ratingResults = [];
            for(user of users) {
                var ratingInfo=ratingCache.get(nicify(user));
                var rating=ratingShift+ratingScale*(ratingInfo.skill-2*ratingInfo.deviation);
                ratingResults.push({name:ratingInfo.name,rating:rating,skill:ratingInfo.skill,deviation:ratingInfo.deviation});
            }
            ratingResults.sort(function(a,b) { return(a.rating > b.rating) ? -1 : (a.rating < b.rating) ? 1 : 0;});

            for(ratingObj of ratingResults) {
                resultMsg+=ratingObj.name.padStart(paddingLength,' ')+": "+ratingObj.rating.toFixed(2)+"\tµ: "+ratingObj.skill.toFixed(2).padStart(5)+"\tφ: "+ratingObj.deviation.toFixed(2)+"\n";
            }
            logger.info('Results message:'+resultMsg);
            message.channel.send("```"+resultMsg+"```");
        }
    }
}

if(msg.startsWith(prefix+'versus')) {
    if(nicify(msg.replace(prefix+'versus',''))=='help') {
        logger.info('Display help message');
        helpMsg='The "!versus" command displays the head-to-head results (rated 2-player games only) between two given players from the perspective of the first player in the list. The color bar represents the winning percentage, from red (bad) to green (good).\n\nExamples:```!versus Cave-o-sapien, Stef``````!versus Stef, Cave-o-sapien```';
        message.channel.send(helpMsg);
    } else {
        logCommand('versus');
        var users = msg.replace(prefix+'versus','').split(",").map(function(x) {
            return x.trim();});
        logger.info('Looking up head-to-head results for '+users);
        knex('users').where('name',users[0]).first('id')
            .then(function(user1Row) {
                if(!user1Row) {
                    message.author.send("No user found with name '"+users[0]+"'");
                    return null;
                } else  {
                    return knex('users')
                .where('name',users[1]).first('id')
                .then(function(user2Row) {
                    if(!user2Row) {
                        message.author.send("No user found with name '"+users[1]+"'");
                    } else {
                        return knex.from('ratingresults as rr')
                    .join('users as u1','rr.user','=','u1.id')
                    .join('users as u2','rr.opponent','=','u2.id')
                    .joinRaw('inner join ratinghistory as rh1 on rh1.user=u1.id and rh1.period=rr.processed and rh1.ratingType=0')
                    .joinRaw('inner join ratinghistory as rh2 on rh2.user=u2.id and rh2.period=rr.processed and rh2.ratingType=0')
                    .where('rr.ratingType', 0)
                    .andWhere('u1.id',user1Row.id)
                    .andWhere('u2.id',user2Row.id)
                    .select('u1.name as user','u2.name as opponent','rh1.skill as user_mu','rh1.deviation as user_phi','rh2.skill as opp_mu','rh2.deviation as opp_phi','rr.score')
                    .then(function(rows) {    
                        if(rows.length>0) {
                            var wins=[0,0,0];
                            var expected=0;
                            var player1=rows[0].user;
                            var player2=rows[0].opponent;
                            for(row of rows) {
                                expected+=glicko.expectedWins(row.user_mu,Array({win:row.score,mu:row.opp_mu,phi:row.opp_phi})).expected;
                                console.log(row);
                                logger.info('Expected running total: '+expected);
                                if(row.score==0.5) {
                                    wins[2]++;
                                    logger.info(row.user+" "+row.opponent+" "+row.count+" "+row.score);
                                } else {
                                    if(row.score==1) {
                                        wins[0]++;
                                    } else {
                                        wins[1]++;
                                    }
                                    logger.info(row.user+" "+row.opponent+" "+row.count+" "+row.score);
                                }
                            }
                            logger.info('Results: '+wins[0]+"-"+wins[1]+"-"+wins[2]);
                            if(wins[2]>0) {
                                var performance=wins[0]+0.5*wins[2]-expected;
                                var perfIndex=Math.max(Math.min(performance,2),-2)/4 + 0.5;
                                var winColor=parseInt(ratingGradient.rgbAt(perfIndex).toHex(),16);
                                //var winColor=parseInt(ratingGradient.rgbAt((wins[0]+0.5*wins[2])/(wins[0]+wins[1]+wins[2])).toHex(),16);
                                message.channel.send({embed:{
                                    color: winColor,
                                    title: player1+' v. '+player2 + " (W–L–D)",
                                    description: wins[0]+'–'+wins[1]+'–'+wins[2]+'\nPerformance: '+(performance<0?"":"+")+performance.toFixed(2)}});
                            } else {
                                var performance=wins[0]-expected;
                                var perfIndex=Math.max(Math.min(performance,2),-2)/4 + 0.5;
                                var winColor=parseInt(ratingGradient.rgbAt(perfIndex).toHex(),16);
                                //var winColor=parseInt(ratingGradient.rgbAt(wins[0]/(wins[0]+wins[1])).toHex(),16);
                                message.channel.send({embed:{
                                    color: winColor,
                                    title: player1+' v. '+player2 +" (W–L)",
                                    description: wins[0]+'–'+wins[1]+'\nPerformance: '+(performance<0?"":"+")+performance.toFixed(2)}});
                            }
                        } else  {
                            message.author.send("No data found");
                        }
                    }).catch((err) => { logger.error( err); throw err })
                    }
                }).catch((err) => { logger.error( err); throw err })
                }
            }).catch((err) => { logger.error( err); throw err })
    }
}
// show someone their peers on the leaderboard
if(msg.startsWith(prefix+'peers')) {
    const ratingShift=50;
    const ratingScale=7.5;

    if(nicify(msg.replace(prefix+'peers',''))=='help') {
        logger.info('Display help message');
        helpMsg='The "!peers" command displays the rating and leaderboard position of a given user and those of the 10 people bracketing them on the Shuffle iT leaderboard.\n\nExample:```!peers Cave-o-sapien```';
        message.channel.send(helpMsg);
    } else {
        logCommand('peers');
        var user=nicify(msg.replace(prefix+'peers',''));
        var sortBy='rating';
        var orderByClause='7.5*(skill-2*deviation) desc';

        // Check leader cache for rating leaderboard
        if(!leaderCache.has(sortBy)) {
            var leaderQ = knex('ratinghistory').where('ratingType',0).max('period');
            knex.from('ratinghistory')
                .join('users','users.id','=','ratinghistory.user')
                .where('ratingType', 0)
                .andWhere('period',leaderQ)
                .andWhereNot('users.status',9)
                .select('users.name', 'ratinghistory.*').limit(30000).orderByRaw(orderByClause).then(function(rows) {
                    if(rows.length>0) {
                        leaderCache.set(sortBy,rows);
                        var period=rows[0].period;
                        var userIndex=rows.findIndex(function(x){return nicify(x.name)==user});
                        if(userIndex>=0) {
                            var topPeer=Math.max(userIndex-5,0);
                            var bottomPeer=Math.min(userIndex+6,rows.length);
                            logger.info('User position on leaderboard is:'+userIndex);
                            var peerMsg="Shuffle iT peers ("+sortBy+", "+periodToDate(ratingStartDate,period).toLocaleDateString()+")\n——————————————————————————————————————————\n"; 
                            var paddingLength=rows.slice(topPeer,bottomPeer).reduce(function(a,b) {return a.name.length > b.name.length ? a:b;}).name.length;
                            for(i=topPeer; i<bottomPeer; i++) {
                                logger.info(rows[i].name + " " +rows[i].skill+ " " +rows[i].period);
                                var rating=ratingShift+ratingScale*(rows[i].skill-2*rows[i].deviation);
                                peerMsg+=(i+1)+"\t"+rows[i].name.padStart(paddingLength,' ')+": "+rating.toFixed(2)+"\tµ: "+rows[i].skill.toFixed(2)+"\tφ: "+rows[i].deviation.toFixed(2)+"\n";
                            } 
                            logger.info('Peer message:'+peerMsg);
                            message.channel.send("```"+peerMsg+"```");
                        } else {
                            message.author.send('You are peerless! Or possibly outside the scope of the stored leaderboard');
                        }
                    } else  {
                        // fail silently or return message?
                        message.author.send("No data found");
                    }
                }).catch((err) => { logger.error( err); throw err })
        } else {
            logger.info('Pulling cached leaderboard for '+sortBy);
            var rows=leaderCache.get(sortBy);
            var period=rows[0].period;
            var userIndex=rows.findIndex(function(x){return nicify(x.name)==user});
            if(userIndex>=0) {
                var topPeer=Math.max(userIndex-5,0);
                var bottomPeer=Math.min(userIndex+6,rows.length);
                var peerMsg="Shuffle iT peers ("+sortBy+", "+periodToDate(ratingStartDate,period).toLocaleDateString()+")\n——————————————————————————————————————————\n"; 
                var paddingLength=rows.slice(topPeer,bottomPeer).reduce(function(a,b) {return a.name.length > b.name.length ? a:b;}).name.length;
                for(i=topPeer; i<bottomPeer; i++) {
                    logger.info(rows[i].name + " " +rows[i].skill+ " " +rows[i].period);
                    var rating=ratingShift+ratingScale*(rows[i].skill-2*rows[i].deviation);
                    peerMsg+=(i+1)+"\t"+rows[i].name.padStart(paddingLength,' ')+": "+rating.toFixed(2)+"\tµ: "+rows[i].skill.toFixed(2)+"\tφ: "+rows[i].deviation.toFixed(2)+"\n";
                } 
                logger.info('Peer message:'+peerMsg);
                message.channel.send("```"+peerMsg+"```");
            } else {
                message.author.send('You are peerless! Or possibly outside the scope of the stored leaderboard');
            }
        }
    }
}

// Display top 10 of leaderboard
if(msg.startsWith(prefix+'leader')) {
    const ratingShift=50;
    const ratingScale=7.5;

    if(nicify(msg.replace(prefix+'leader',''))=='help') {
        logger.info('Display help message');
        helpMsg='The "!leader" command displays the top N of the Shuffle iT leaderboard. By default N=10 and the leaderboard is sorted by rating. Max N is 25 due to message size restrictions. To see where a particular user is on the leaderboard, try the "!peers" command. The leaderboard can optionally be sorted by skill (µ) by including "µ" or "skill" after the command.\n\nExamples: ```!leader``````!leader20 mu```';
        message.channel.send(helpMsg);
    } else {
        logCommand('leader');
        var topN=10;
        var sortBy='rating';
        var orderByClause='7.5*(skill-2*deviation) desc';
        if(msg.indexOf('mu')>0 || msg.indexOf('skill')>0 || msg.indexOf('µ')>0) {
            sortBy='µ';
            orderByClause='skill desc';
        }

        var suffix=msg.split(" ")[0].replace(prefix+'leader','');

        if(suffix.length>0 && !isNaN(suffix)) {
            topN=suffix;
            logger.info('Show top '+topN);
        } 

        if(topN>25) topN=25;
        // Check leader cache for rating leaderboard
        if(!leaderCache.has(sortBy)) {
            var leaderQ = knex('ratinghistory').where('ratingType',0).max('period');
            knex.from('ratinghistory')
                .join('users','users.id','=','ratinghistory.user')
                .where('ratingType', 0)
                .andWhere('period',leaderQ)
                .andWhereNot('users.status',9)
                .select('users.name', 'ratinghistory.*').limit(30000).orderByRaw(orderByClause).then(function(rows) {
                    if(rows.length>0) {
                        leaderCache.set(sortBy,rows);
                        var j=0;
                        var period=rows[0].period;
                        var leaderMsg="Shuffle iT Top "+topN+" ("+sortBy+", "+periodToDate(ratingStartDate,period).toLocaleDateString()+")\n————————————————————————————————————————————\n"; 
                        console.log(rows.slice(0,topN)[0].name);
                        console.log(rows.slice(0,topN)[0].name.length);
                        var paddingLength=rows.slice(0,topN).reduce(function(a,b) {return a.name.length > b.name.length ? a:b;}).name.length;
                        for(i=0; i<topN; i++) {
                            logger.info(rows[i].name + " " +rows[i].skill+ " " +rows[i].period);
                            var rating=ratingShift+ratingScale*(rows[i].skill-2*rows[i].deviation);
                            leaderMsg+=rows[i].name.padStart(paddingLength,' ')+": "+rating.toFixed(2)+"\tµ: "+rows[i].skill.toFixed(2)+"\tφ: "+rows[i].deviation.toFixed(2)+"\n";
                        } 
                        logger.info('Leader message:'+leaderMsg);
                        message.channel.send("```"+leaderMsg+"```");
                    } else  {
                        // fail silently or return message?
                        message.author.send("No data found");
                    }
                }).catch((err) => { logger.error( err); throw err })
        } else {
            logger.info('Pulling cached leaderboard for '+sortBy);
            var rows=leaderCache.get(sortBy);
            var period=rows[0].period;
            var leaderMsg="Shuffle iT Top "+topN+" ("+sortBy+", "+periodToDate(ratingStartDate,period).toLocaleDateString()+")\n————————————————————————————————————————————\n"; 
            console.log(period);
            var paddingLength=rows.slice(0,topN).reduce(function(a,b) {return a.name.length > b.name.length ? a:b;}).name.length;
            for(i=0; i<topN; i++) {
                logger.info(rows[i].name + " " +rows[i].skill+ " " +rows[i].period);
                var rating=ratingShift+ratingScale*(rows[i].skill-2*rows[i].deviation);
                leaderMsg+=rows[i].name.padStart(paddingLength,' ')+": "+rating.toFixed(2)+"\tµ: "+rows[i].skill.toFixed(2)+"\tφ: "+rows[i].deviation.toFixed(2)+"\n";
            }
            logger.info('Leader message:'+leaderMsg);
            message.channel.send("```"+leaderMsg+"```");
        }
    }
}
if(msg.startsWith(prefix+'history')) {
    var lineWidth=59
        var imgWidth=480;

    if(nicify(msg.replace(prefix+'history',''))=='help') {
        logger.info('Display help message');
        helpMsg='The "!history" command displays some of Donald X.’s design notes (aka "Secret History") for a given card or card-shaped thing.\n\nExamples:```!history Secret Chamber``````!history Expedition```\nTo conserve channel space, the text is rendered as an image. For some of the longer histories, you may need to open the image in your browser.';
        message.channel.send(helpMsg);
    } else {
        logCommand('history');
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
    if(nicify(msg.replace(prefix+'kingdom',''))=='help') {
        helpMsg='The "!kingdom" command displays a kingdom image based on *either* a Shuffle iT game ID or comma-separated list of cards, events and landmarks. For the CSV-list version, it requires at least 10 unique cards. If a Looter is included but no specific Ruin is specified, one will be randomly chosen and included. Likewise, if the list includes "Knights" but no named Knight, then one will be randomly chosen. The Young Witch Bane can be indicated by a "(b)" after the desired Bane card name. No Bane will be automatically included (at this time). If either Colony or Platinum is included in the list, both will be displayed.\n\nExample: ```!kingdom knights,artificer,market,tomb,bonfire,urchin,relic,death cart,vampire,bandit camp,dungeon(b),young witch,werewolf``````!kingdom 21278249```';
        message.channel.send(helpMsg);
    } else {
        logCommand('kingdom');
        getKingdom(null,msg.replace(prefix+'kingdom',''),drawKingdom,function(err,filename) {
            message.channel.send('', {files:["/tmp/"+filename+".png"]})});
    } }
})

bot.login(config.discord.dev.token);
