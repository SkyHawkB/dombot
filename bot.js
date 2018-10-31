const Discord = require('discord.js');
const gm = require('gm');
const crypto = require('crypto');
const fs = require('fs');
const stream = require('stream');
const config = require('./config');
const cardFile=fs.readFileSync("all_cards.json");
const historyFile=fs.readFileSync("secret_all.json");
const artistFile=fs.readFileSync("artists.json");
const request=require("request");
const winston=require('winston');
const async=require('async');
const knex=require('knex');
const vega=require('vega');
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

var cardList=JSON.parse(cardFile);
var allHist=JSON.parse(historyFile);
var cardArt=JSON.parse(artistFile);

const bot = new Discord.Client();
const ratingStartDate = new Date('01-JAN-2017');

function periodToDate(startDate, period) {
    var tempDate=new Date(startDate);
    tempDate.setDate(tempDate.getDate()+(period-1));
    return tempDate;
}

function nicify(inputName) {
    return inputName.trim().replace(/'|’/g,"").replace(/\s/g,"-").replace(/_/g,"-").toLowerCase();
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
            var knex = require('knex')({
                client: config.shitdb.dev.client,
                connection: {
                    host : config.shitdb.dev.host,
                user : config.shitdb.dev.user,
                password : config.shitdb.dev.password,
                database : config.shitdb.dev.database}
            });
            logger.info('Game ID:'+gameId);

            knex.from('gameresults')
                .where('gameid','=',gameId)
                .first('pregame','gameid')
                .asCallback(function(err,row) {
                    if(err) drawCallback(err,kingdom,msgCallback)
                    else {
                        logger.info(row.pregame);
                        var gameInfo=JSON.parse(row.pregame);
                        kingdom=gameInfo.gameParameters.setupInstructions.kingdom;
                        var baneCard=gameInfo.gameParameters.setupInstructions.baneCard;
                        logger.info('Bane: '+baneCard);
                        kingdom[kingdom.indexOf(baneCard)]+='(b)';
                        var colony=gameInfo.gameParameters.setupInstructions.usesColonies;
                        logger.info('Colony: '+colony);
                        if (colony) {
                            kingdom.push('COLONY');
                            kingdom.push('PLATINUM');
                        }
                        logger.info('Kingdom: '+kingdom);
                        logger.info('Kingdom count: '+kingdom.length);
                        drawCallback(null,kingdom,msgCallback);
                        //message.channel.send("No data found");
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
            type:'',
            textColor:''
        };

        logger.info('drawKingdom: Kingdom list:'+kingdom);
        for(var i=0; i<kingdom.length; i++) {
            kingdom[i]=nicify(kingdom[i]);
            logger.info(kingdom[i]);
            if(kingdom[i]=='castles')
                kingdom[i]='humble-castle';
            if(kingdom[i].indexOf('(b)')>0) {
                kingdom[i]=kingdom[i].replace(/\(b\)/,"");
                kingdom[i]=kingdom[i].replace(/-$/,"");
                bane.name=kingdom[i];
                bane.type=cardList.cards.filter(function(x){ return x.nicename==bane.name })[0].type;
                logger.info('Bane is '+bane.name);
                logger.info('Bane type is '+bane.type);

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
        const looters = ["marauder","death-cart","cultist"];
        var looterCount = cardSupply.filter(function(x) { return looters.includes(x.nicename)}).length;
        var ruinsCount = cardSupply.filter(function(x) { return x.type == 'Action-Ruins'}).length;
        logger.info('Looter array length: '+looterCount);
        logger.info('Ruins array length: '+ruinsCount);

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
            console.log(row1);
            console.log(row2);
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
            }

            for(var i=0; i<csoFiles.length;i++) {
                gmCommand = gmCommand + ".in('-page','+"+i*(csoWidth+padding)+"+"+2*(padding+cardHeight)+"').in('"+csoFiles[i]+"')";
            }
            // Handle this with a series of callbacks instead of eval?
            gmCommand = gmCommand + ".mosaic().background('transparent').stream('miff').pipe(passThrough);";
            logger.info(gmCommand);
            eval(gmCommand);
            gm(passThrough)
                .background('transparent')
                .fontSize('30')
                .fill(bane.textColor)
                .font('TrajanPro-Bold.ttf')
                .draw('text +'+(bane.X+110)+'+'+(bane.Y+290)+' BANE')
                .resize(800,null)
                .write('/tmp/'+filename+'.png',function(err) {
                    if(!err) {
                        msgCallback(null,filename)
                    } else {
                        msgCallback(err,filename);
                    }
                });  
        }
        else {
            // Create new error here?
            logger.info('Need 10 kingdom cards');
            msgCallback(null,filename)
        }
    } else {
        msgCallback(err,filename)
    }
}

bot.on('ready', function (evt) {
    logger.info('Connected');
    logger.info('Logged in as: ');
    logger.info(bot.username + ' - (' + bot.id + ')');
        });
    bot.on('message', message => {
        var prefix='!'
        var msg=message.content;
    if(msg.startsWith(prefix+'help')) {
        var helpMsg="Available commands:\n------------------------------------------------\n";
        helpMsg+="**!kingdom** - generate kingdom image\n";
        helpMsg+="**!history** - display secret history for a card\n";
        helpMsg+="**!rating** - Shuffle iT rating for player(s)\n";
        helpMsg+="**!results** - summary of unprocessed results for player\n";
        helpMsg+="**!leader** - displays top 10 of Shuffle iT leaderboard\n";
        helpMsg+="**!chart** - show rating/skill in a chart\n";
        helpMsg+="**!versus** - display head-to-head record for two players\n";
        helpMsg+="**!art** - shows art for card/box/card-shaped-thing\n";
        helpMsg+="\nFor more detailed help, type the command followed by 'help'";
        message.channel.send(helpMsg);
    }

    if(msg.startsWith(prefix+'art')) {
        if(nicify(msg.replace(prefix+'art',''))=='help') {
            logger.info('Display help message for art');
            helpMsg='The "!art" command shows the original, frameless art for the specified card, set, or *card-shaped-thing* (Landmark, Event, Project etc.).\n\nUsage: ```!art <card name>```\nExamples:```!art Expedition``````!art Page``````!art Dominion```';
            message.channel.send(helpMsg);
        } else {
            var cardname=nicify(msg.replace(prefix+'art',''));
            logger.info('Looking for art for '+cardname);
            cardartFile = "./images/art/"+cardname+".jpg";

            var illustrator=cardArt.artists.filter(function(x) { return x.card==cardname})[0].artist;
            logger.info('Illustrator: '+illustrator);

            if(fs.existsSync(cardartFile)) {
                message.channel.send('*Illustrator: '+illustrator+'*', {files:[cardartFile]});
                logger.info('Sent card art for: '+cardname);
            }
        }
    }

    if(msg.startsWith(prefix+'silver')) {
        var user = msg.replace(prefix+'silver','').trim();
        var knex = require('knex')({
            client: config.shitdb.dev.client,
            connection: {
                host : config.shitdb.dev.host,
            user : config.shitdb.dev.user,
            password : config.shitdb.dev.password,
            database : config.shitdb.dev.database}
        });

        knex.from('gameresults')
            .join('ratingresults','ratingresults.gameid','=','gameresults.gameid')
            .join('users','users.id','=','ratingresults.user')
            .where('users.name', user)
            .select('gameresults.gameresult','users.id','gameresults.gameid').then(function(rows) {
                if(rows.length>0) {
                    var silverCount=0;
                    for(row of rows) {
                        var gameResults=JSON.parse(row.gameresult);
                        if(gameResults) {
                            var freq=gameResults.playerResults.filter(function(x) {return x.playerId.id==row.id})[0].ownedCards.frequencies;
                            if(Object.keys(freq).length>0) {
                                if(freq.SILVER) {
                                    logger.info('Looking for Silvers in game '+row.gameid+': found '+freq.SILVER);
                                    silverCount+=freq.SILVER;
                                }
                            }
                        }
                    }
                    logger.info('Total Silvers: '+silverCount);
                    message.channel.send('Total silvers in deck at end of games: '+silverCount);
                }
                else  {
                    message.channel.send("No data found");
                }
            }).catch((err) => { logger.error( err); throw err })
        .finally(() => {
            knex.destroy();
        });
    }

    if(msg.startsWith(prefix+'results')) {
        if(nicify(msg.replace(prefix+'results',''))=='help') {
            logger.info('Display help message for results');
            helpMsg='The "!result" command lists the current, unprocessed 2-player results for the given player and an estimate of what that player\'s new µ, φ and rating will be based on those results.';
            message.channel.send(helpMsg);
        } else {
            var user = msg.replace(prefix+'results','').trim();
            logger.info('Looking up unprocessed results for '+user);
            const ratingShift=50;
            const ratingScale=7.5;
            var knex = require('knex')({
                client: config.shitdb.dev.client,
                connection: {
                    host : config.shitdb.dev.host,
                user : config.shitdb.dev.user,
                password : config.shitdb.dev.password,
                database : config.shitdb.dev.database}
            });
            // Grab data for most recent processed period of user
            // What do we do if there is no rating history for a user?
            var currentPeriod = knex('ratinghistory as rh').join('users as u','rh.user','=','u.id').where('ratingType',0).andWhere('u.name',user).max('period');
            knex.from('ratingresults as rr')
                .join('users as u1','rr.user','=','u1.id')
                .join('users as u2','rr.opponent','=','u2.id')
                .join('ratinghistory as rho','rho.user','=','rr.opponent')
                .join('ratinghistory as rhu','rhu.user','=','rr.user')
                .where('u1.name', user)
                .andWhere('rr.ratingType', 0)
                .andWhere('rho.ratingType',0)
                .andWhere('rhu.ratingType',0)
                .andWhereNot('u2.status',9)
                .andWhere('rr.processed',0)
                .andWhere('rho.period',currentPeriod)
                .andWhere('rhu.period',currentPeriod)
                .select('u1.name', 'u2.name as opponent','rr.gameid','rr.score','rho.skill as opp_mu','rho.deviation as opp_phi','rhu.volatility as user_sigma','rhu.skill as user_mu','rhu.deviation as user_phi')
                .then(function(rows) {
                    if(rows.length>0) {
                        var userMu=rows[0].user_mu;
                        var userPhi=rows[0].user_phi;
                        var userSigma=rows[0].user_sigma;
                        var resultsArray=[]; 
                        for(row of rows) {
                            resultsArray.push({win:row.score,mu:row.opp_mu,phi:row.opp_phi});
                        }
                        var newRating=glicko.update(userMu,userPhi,userSigma,0.4,resultsArray);
                        var winSummary=glicko.expectedWins(userMu,resultsArray);
                        console.log('New µ:'+newRating.mu+' New phi:'+newRating.phi);
                        console.log(winSummary);
                        var resultMsg='```Won '+winSummary.wins+'/'+winSummary.played+', expected: '+winSummary.expected.toFixed(2)+'\n';
                        resultMsg+='Current:\t'+(ratingScale*(userMu-2*userPhi)+ratingShift).toFixed(2)+'\tµ: '+userMu.toFixed(2).padStart(5)+'\tφ: '+userPhi.toFixed(2)+'\n'; 
                        resultMsg+='New:    \t'+(ratingScale*(newRating.mu-2*newRating.phi)+ratingShift).toFixed(2)+'\tµ: '+newRating.mu.toFixed(2).padStart(5)+'\tφ: '+newRating.phi.toFixed(2)+'```';
                        message.channel.send(resultMsg);
                    } else  {
                        message.channel.send("No unprocessed results found, or rating history missing for some or all players.");
                    }
                }).catch((err) => { logger.error( err); throw err })
            .finally(() => {
                knex.destroy();
            });
        }
    }

    if(msg.startsWith(prefix+'chart')) {
        if(nicify(msg.replace(prefix+'chart',''))=='help') {
            logger.info('Display help message for chart');
            helpMsg='The "!chart" command displays a line graph of the given player\'s skill (µ) and rating over time.';
            message.channel.send(helpMsg);
        } else {
            var user = msg.replace(prefix+'chart','').trim();
            // Change to allow user to go back X periods?
            const ratingShift=50;
            const ratingScale=7.5;
            logger.info('Generating rating chart for '+user);

            var knex = require('knex')({
                client: config.shitdb.dev.client,
                connection: {
                    host : config.shitdb.dev.host,
                user : config.shitdb.dev.user,
                password : config.shitdb.dev.password,
                database : config.shitdb.dev.database}
            });

            knex.from('ratinghistory')
                .join('users','users.id','=','ratinghistory.user')
                .where('name', user)
                .andWhere('ratingType', 0)
                .orderBy('period','desc')
                .limit(90)
                .select('users.name', 'ratinghistory.*')
                .then(function(rows) {
                    if(rows.length>0) {
                        var ratingChart=JSON.parse(ratingTemplate);
                        ratingChart.title.text+=user;
                        var ratingArray=[];
                        for(row of rows) {
                            var ratingCalc=ratingShift+ratingScale*(row.skill-2*row.deviation)
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
                        message.channel.send("No data found");
                    }
                }).catch((err) => { logger.error( err); throw err })
            .finally(() => {
                knex.destroy();
            });
        }
    }

    if(msg.startsWith(prefix+'rating')) {
        var users = msg.replace(prefix+'rating','').split(",").map(function(x) {
            return x.trim();});

        // handle multiple users
        // how to deal with missing data
        const ratingShift=50;
        const ratingScale=7.5;
        logger.info('Looking up rating for '+users);

        var knex = require('knex')({
            client: config.shitdb.dev.client,
            connection: {
                host : config.shitdb.dev.host,
            user : config.shitdb.dev.user,
            password : config.shitdb.dev.password,
            database : config.shitdb.dev.database}
        });

        var ratingQ = knex('ratinghistory').where('ratingType',0).max('period');
        knex.from('ratinghistory')
            .join('users','users.id','=','ratinghistory.user')
            .whereIn('name', users)
            .andWhere('ratingType', 0)
            .andWhere('period',ratingQ)
            .select('users.name', 'ratinghistory.*').orderByRaw('7.5*(skill-2*deviation) desc').then(function(rows) {
                if(rows.length>0) {
                    var resultMsg='';
                    for(row of rows) {
                        logger.info(row.name + " " +row.skill+ " " +row.period);
                        var rating=ratingShift+ratingScale*(row.skill-2*row.deviation)
                resultMsg+=row.name.padStart(10,' ')+": "+rating.toFixed(2)+"\tµ: "+row.skill.toFixed(2).padStart(5)+"\tφ: "+row.deviation.toFixed(2)+"\n";
                    } 
                    logger.info('Results message:'+resultMsg);
                    message.channel.send("```"+resultMsg+"```");
                } else  {
                    // fail silently or return message?
                    message.channel.send("No data found");
                }
            }).catch((err) => { logger.error( err); throw err })
        .finally(() => {
            knex.destroy();
        });
    }

    if(msg.startsWith(prefix+'versus')) {
        var users = msg.replace(prefix+'versus','').split(",").map(function(x) {
            return x.trim();});
        // check for exactly 2 users
        logger.info('Looking up head-to-head results for '+users);

        var knex = require('knex')({
            client: config.shitdb.dev.client,
            connection: {
                host : config.shitdb.dev.host,
            user : config.shitdb.dev.user,
            password : config.shitdb.dev.password,
            database : config.shitdb.dev.database}
        });

        //var ratingQ = knex('ratingresults').where('ratingType',0).max('period');
        knex.from('ratingresults as rr')
            .join('users as u1','rr.user','=','u1.id')
            .join('users as u2','rr.opponent','=','u2.id')
            .where('rr.ratingType', 0)
            .andWhere('u1.name',users[0])
            .andWhere('u2.name',users[1])
            .select('u1.name as user','u2.name as opponent','rr.score')
            .countDistinct('gameid as count')
            .groupBy('u1.name','u2.name','rr.score').then(function(rows) {
                if(rows.length>0) {
                    var wins=[0,0]
                for(row of rows) {
                    wins[0]+=(row.count*row.score) 
                wins[1]+=(row.count*(1-row.score))
                logger.info(row.user+" "+row.opponent+" "+row.count+" "+row.score);
                }
            logger.info('Results: '+wins[0]+"-"+wins[1]);
            message.channel.send("```"+users[0]+' v. '+users[1]+': '+wins[0]+"-"+wins[1]+"```");
                } else  {
                    // fail silently or return message?
                    message.channel.send("No data found");
                }
            }).catch((err) => { logger.error( err); throw err })
        .finally(() => {
            knex.destroy();
        });
    }

    // Display top 10 of leaderboard
    if(msg.startsWith(prefix+'leader')) {
        const ratingShift=50;
        const ratingScale=7.5;
        if(msg.indexOf('live')>0) {
            // Calculate this on the fly?
            var mode="live"
        } else {
            var mode="stale"
        }

        var knex = require('knex')({
            client: config.shitdb.dev.client,
            connection: {
                host : config.shitdb.dev.host,
            user : config.shitdb.dev.user,
            password : config.shitdb.dev.password,
            database : config.shitdb.dev.database}
        });

        var leaderQ = knex('ratinghistory').where('ratingType',0).max('period');
        knex.from('ratinghistory')
            .join('users','users.id','=','ratinghistory.user')
            .where('ratingType', 0)
            .andWhere('period',leaderQ)
            .andWhereNot('users.status',9)
            .select('users.name', 'ratinghistory.*').limit(10).orderByRaw('7.5*(skill-2*deviation) desc').then(function(rows) {
                if(rows.length>0) {
                    var leaderMsg="Shuffle iT Top 10"+((mode=='live')?" (live)":"")+"\n---------------------------------------------\n"; 
                    for(row of rows) {
                        logger.info(row.name + " " +row.skill+ " " +row.period);
                        var rating=ratingShift+ratingScale*(row.skill-2*row.deviation)
                leaderMsg+=row.name.padStart(15,' ')+": "+rating.toFixed(2)+"\tµ: "+row.skill.toFixed(2)+"\tφ: "+row.deviation.toFixed(2)+"\n";
                    } 
                    logger.info('Leader message:'+leaderMsg);
                    message.channel.send("```"+leaderMsg+"```");
                } else  {
                    // fail silently or return message?
                    message.channel.send("No data found");
                }
            }).catch((err) => { logger.error( err); throw err })
        .finally(() => { knex.destroy();});
    }

    if(msg.startsWith(prefix+'history')) {
        var lineWidth=59
            var imgWidth=480;


        if(nicify(msg.replace(prefix+'history',''))=='help') {
            logger.info('Display help message');
            helpMsg='The "!history" command displays some of Donald X’s design notes (aka "Secret History") for a given card or *card-shaped thing*.\n\nUsage: ```!history <card name>```Example:```!history Secret Chamber```\nTo conserve channel space, the text is rendered as an image. For some of the longer histories, you may need to open the image in your browser.';
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
                if(nicify(msg.replace(prefix+'kingdom',''))=='help') {
                    helpMsg='The "!kingdom" command displays a kingdom image based on a comma-separated list of cards, events and landmarks. It requires at least 10 unique cards. If a Looter is included but no specific Ruin is specified, one will be randomly chosen and included. Likewise, if the list includes "Knights" but no named Knight, then one will be randomly chosen. The Young Witch bane can be indicated by a "(b)" after the desired bane card name. No bane will be automatically included (at this time).\n\nExample: ```!kingdom knights,artificer,market,tomb,bonfire,urchin,relic,death cart,vampire,bandit camp,dungeon(b),young witch,werewolf```';
                    message.channel.send(helpMsg);
                } else {
                    getKingdom(null,msg.replace(prefix+'kingdom',''),drawKingdom,function(err,filename) {
                        message.channel.send('', {files:["/tmp/"+filename+".png"]})});
                } }
    })

bot.login(config.discord.dev.token);
