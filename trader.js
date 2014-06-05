var Promise = require('bluebird');
var _  = require('lodash');
// var jf = require('jsonfile'); // shoud be gone
// var fx = require('money'); // should be gone

// _.extend(fx, jf.readFileSync('rates.json'));

var fs = require('fs');

var EventEmitter = require("events").EventEmitter;
var trader = new EventEmitter();

var RawSpreads = {
    'EUR' : [],
    'USD' : []
};
trader.RawSpreads = RawSpreads; // export this.

//var FeeAdjustedSpreads = {};

/*
    Gets spread for a given exchange and then stores it.
*/
trader.getSpread = function(exchangeName, currency){
    var self = this;
    return this.exchanges[exchangeName].getSpread(currency).then(function(data){
        return storeSpread(data, exchangeName)        
    }).catch(function(e){
        console.error('Error in getSpread', exchangeName, currency, e);
    });
}

/*
    Stores spread data.
*/
function storeSpread(data, exchange){
    data.exchange = exchange;


    // store data globally
    RawSpreads[exchange] = data;

    // var adjustedData = adjust_to_fee(data, trader.exchanges[exchange].fee);
    // FeeAdjustedSpreads[exchange] = adjustedData;

    return data;
}

/*
    Load all enabled exchanges
*/
trader.init = function(conf){
    conf = conf || require('./config.js');

    var self = this;
    self.exchanges = {};
    _.forOwn(conf.exchanges, function(exchangeConfig, exchangeName){
        if(!exchangeConfig.enabled){
            return;
        }

        var Lib = require('./' + exchangeName + '.js');
        self.exchanges[exchangeName] = new Lib(exchangeConfig, self);
        self.exchanges[exchangeName].watch = self.exchanges[exchangeName].watch || generalWatchFunction;
    });

    return Promise.all(_.pluck(self.exchanges, 'initialized'));
}

/*
Gets all spreads for given currency, or default 'EUR'
*/
trader.getAllSpreads = function(currency){
    var self = this;
    currency = currency || 'EUR';

    var promises = [];

    _.forOwn(this.exchanges, function(exchange, exchangeName){
        if(_.contains(exchange.currencies, currency)){
            promises.push(self.getSpread(exchangeName, currency));
        }
    });

    return Promise.all(promises);
}

/*
    Default watch function to be used in exchange classes,
    Basically keeps polling for spreads every second,
    and emits 'spread_data' on trader when something new is received.
*/
function generalWatchFunction(currency, eventEmitter){
    var self = this;
    var rate = this.pollingRate || 1000;
    setInterval(function(){
        self.getSpread(currency);
    }, rate);
}

/*
    Return highest bid, lowest ask, spread in currency units, and percentage of the spread
*/
trader.extractBuySell = function(spread){
    return {
        ask : spread.asks[0][0],
        bid : spread.bids[0][0],
        spread: (spread.asks[0][0] - spread.bids[0][0]).toFixed(2),
        percent : ((spread.asks[0][0] - spread.bids[0][0]) * 100 / spread.asks[0][0] ).toFixed(2)
    };
}

function logifyTrade(tradeOptions){
    tradeOptions.datetime = (new Date()).toString();
    return _.template('${ datetime }: ${ buySell } @ ${ exchange }, ${ volume } at ${ price } \n', tradeOptions);
}

/*
    Wrapper command to send trades.
*/
trader.trade = function(options){
    options.volume = options.volume || options.amount; // handle both types of indata, both volume and amount    
    fs.appendFile('./opened_trades.txt', logifyTrade(options));
    return trader.exchanges[options.exchange].trade(options).then(function(){
        console.log('trade closed! ', logifyTrade(options))
        fs.appendFile('./closed_trades.txt', logifyTrade(options));
    // }).error(function(error){ // TODO: Specify error type here.
    //     console.log('trade aborted: ', error);
    //     fs.appendFile('./closed_trades.txt', '-- ' +error + " " + logifyTrade(options));
    //     throw error;
    }).catch(function(error){
        console.log('error in trade: ', error);
        fs.appendFile('./closed_trades.txt', '!! ' +error + " " + logifyTrade(options));
        throw error;
    });
}

/*
    Update all balances
*/

trader.getBalances = function(){
    return Promise.map(_.values(trader.exchanges), function(exchange){
        return exchange.getBalance();
    });
}

/*
    Poll or otherwise listen to updated market spread data for all exchanges
    that deal in selected currency. 
*/
trader.watch = function(currency){
    var self = this;
    var exchangesToWatch = [];
    _.forOwn(this.exchanges, function(exchange, exchangeName){
        if(_.contains(exchange.currencies, currency)){
            exchangesToWatch.push(exchange);
        }
    });

    // start them up a bit asynchronously
    var avgWaitingTime = Math.round(1000 / exchangesToWatch.length);
    for (var i = exchangesToWatch.length - 1; i >= 0; i--) {
        exchangesToWatch[i].watch(currency, self);
    };
};

/*
    When trader receives a new spread data for a given exchange
*/

function checkForSpreadUpdates(spread){
    // console.log('trader got spread data for', spread.exchange);
    try {
        spread.fee = trader.exchanges[spread.exchange].fee;
    } catch(e){
        console.log('checkForSpreadUpdates error: ', e, spread);
        throw e;
    }
    if(_.isEqual(spread, RawSpreads[spread.currency][spread.exchange])){
        // console.log('SPREADS ARE EQUAL!!');
        return;
    }
    // console.log('different spreads. old: ', RawSpreads[spread.currency][spread.exchange], 'new: ', spread);
    RawSpreads[spread.currency][spread.exchange] = spread;
    trader.emit('updated_spread_data', spread);
}

trader.on('spread_data', checkForSpreadUpdates);

module.exports = trader;