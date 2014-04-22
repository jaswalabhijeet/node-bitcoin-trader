
var _  = require('lodash');
var jf = require('jsonfile');
var fx = require('money');

var fs = require('fs');

var Promise = require('bluebird');
var request = Promise.promisify(require('request'));
var config = require('./config.js');

var baseCurrency = 'USD';

var ratesPromise = request('http://openexchangerates.org/api/latest.json?app_id=' + config.rates.app_id, {json:true}).spread(function(request, data){
	_.extend(fx, data);
});


var trader = require('./trader.js');


/*
    Two functions to take into account fees.
*/
function buying_cost(amount, fee){
    return amount * (1 + fee);
}
function selling_rev(amount, fee){
    return amount * (1 - fee);   
}

var combinedSpreads = {
	bids : [],
	asks : []
};

/**
* The merge part of the merge sort algorithm.
*
* @param {function} comparatorFn The comparator function.
* @param {array} arr1 The first sorted array.
* @param {array} arr2 The second sorted array.
* @returns {array} The merged and sorted array.
*/
function merge(comparatorFn, arr1, arr2) {
var result = [], left1 = arr1.length, left2 = arr2.length;
while (left1 > 0 && left2 > 0) {
  if (comparatorFn(arr1[0], arr2[0]) <= 0) {
    result.push(arr1.shift());
    left1--;
  } else {
    result.push(arr2.shift());
    left2--;
  }
}
if (left1 > 0) {
  result.push.apply(result, arr1);
} else {
  result.push.apply(result, arr2);
}
return result;
}
function equivComparatorAsc(a, b){
	return (a.deFactoPrice - b.deFactoPrice);
}
function equivComparatorDesc(a, b){
	return (b.deFactoPrice - a.deFactoPrice);
}

var currentCurrency, currentExchange, currentFee, currencyMultiplier, feeMultiplier, deFactoMultiplier;


function objectifySpreadItem(item){
	return {
		price : parseFloat(item[0]),
		amount : parseFloat(item[1]),
		exchange : currentExchange,
		currency : currentCurrency, 
		equivPrice :  parseFloat(item[0] * currencyMultiplier), 
		deFactoPrice : parseFloat(item[0] * deFactoMultiplier)
	};
}

/*
	Maintains a sorted of best trades available in the system
*/
function addToEquivIndex(spread){
	console.log('updated spread data 	', spread.exchange);

	// clear out previous data for this exchange/currency combo, we'll add new ones now!
	_.remove(combinedSpreads.asks, {exchange:spread.exchange, currency: spread.currency});
	_.remove(combinedSpreads.bids, {exchange:spread.exchange, currency: spread.currency});


	// weird workaround, should probably just pass it in as an object...
	currentCurrency = spread.currency;
	currentExchange = spread.exchange;
	currentFee = spread.fee;
	currencyMultiplier = fx(1).from(currentCurrency).to(baseCurrency)

	// for buying
	feeMultiplier = buying_cost(1, currentFee);
	deFactoMultiplier = feeMultiplier * currencyMultiplier;

	combinedSpreads.asks = _.first(merge(equivComparatorAsc, combinedSpreads.asks, _.map(spread.asks, objectifySpreadItem)), 20);

	// for selling
	feeMultiplier = selling_rev(1, currentFee);
	deFactoMultiplier = feeMultiplier * currencyMultiplier;
	combinedSpreads.bids = _.first(merge(equivComparatorDesc, combinedSpreads.bids, _.map(spread.bids, objectifySpreadItem)), 20);

	// console.log('merged asks: ', combinedSpreads.asks);
	// console.log('merged bids: ', combinedSpreads.bids);
}

var balances;

function initBalances(){
	// leaving this
	if(balances){
		return;
	}
	balances = {};

	_.each(trader.exchanges, function(exchange, name){
		balances[name] = _.cloneDeep(exchange.balance);
	});
}

// much spaghetti in here... :/
function affordedTradeAmount(buySell, nextTrade, neededAmount){
	initBalances();

	var maxAffordedAmount;
	// TODO: only taking fees in account when buying, not when selling (fees normally charged in fiat). Is that right?
	if(buySell.toLowerCase() === 'buy'){
		var fee = trader.exchanges[nextTrade.exchange].fee;
		maxAffordedAmount = balances[nextTrade.exchange][nextTrade.currency] / buying_cost(nextTrade.price,fee);
	} else { // sell
		maxAffordedAmount = balances[nextTrade.exchange]['BTC'];
	}

	if(_.isNaN(maxAffordedAmount)){
		throw "Something went wrong with calculating maxAffordedAmount" + JSON.stringify(nextTrade);
	}

	
	var comparedAmounts = [maxAffordedAmount, nextTrade.amount];
	if(neededAmount){ // sometimes I just want to get whatever
		comparedAmounts.push(neededAmount);
	}

	// this is what will be returned
	var actualTradeAmount = _.min(comparedAmounts);

	if(actualTradeAmount == 0) {
		return 0;
	}

	// update balances object.
	if(buySell.toLowerCase() === 'buy'){
		balances[nextTrade.exchange][nextTrade.currency] -= actualTradeAmount * buying_cost(nextTrade.price,fee);
	} else {
		balances[nextTrade.exchange]['BTC'] -= actualTradeAmount;
	}

	return actualTradeAmount;
}

function theoreticalTradeAmount(nextTrade, neededAmount){
	return _.min([nextTrade.amount, neededAmount]);
}

/*
	Gives you the best trades to buy or sell neededAmount or BTC. 
	Either practically (takes into account balances) or theoretically.
*/
function bestTrade(buySell, neededAmount, theoretical){
	var availableTrades = _.cloneDeep( (buySell.toLowerCase() === 'buy') ? combinedSpreads.asks : combinedSpreads.bids );
	var tradeAmount, nextTrade;
	var outputTrades = [], possibleAmounts = [];
	while(neededAmount > 0 && (nextTrade = availableTrades.shift())){
		// figure out how much I can trade
		tradeAmount = theoretical ? theoreticalTradeAmount(nextTrade, neededAmount) : affordedTradeAmount(buySell, nextTrade, neededAmount);

		if(tradeAmount === 0){ // this trade can't be done, prolly broke on exchange
			console.log('cannot afford to make trade on ', nextTrade.exchange)
			continue;
		}

		neededAmount -= tradeAmount;
		nextTrade.amount = tradeAmount;
		outputTrades.push(nextTrade);
	}
	return outputTrades;
}

/*
    Either simulates or trades on two exchanges if arbitrage possibilities
    arise. This is where things like fees and balances are taken into account.
*/
function spitArbitrage(gtfo, theoretical){
	var arbitrades = [];
    var asks = _.cloneDeep(combinedSpreads.asks);
    var bids = _.cloneDeep(combinedSpreads.bids);

    var lowAsk = asks.shift();
    var highBid = bids.shift();

    gtfo = gtfo || 1;

    var buyingAffordance, sellingAffordance, tradeAmount;

    console.log('best prices: 	buy ', 
    	lowAsk.exchange, lowAsk.price.toFixed(2), lowAsk.deFactoPrice.toFixed(2), lowAsk.amount.toFixed(3), '	sell ', highBid.exchange, highBid.price.toFixed(2), highBid.deFactoPrice.toFixed(2), highBid.amount.toFixed(3));

    while ( lowAsk && highBid && lowAsk.deFactoPrice * gtfo < highBid.deFactoPrice ){
    	if( theoretical ) {
    		buyingAffordance = lowAsk.amount;
    		sellingAffordance = highBid.amount;
    	} else {
	    	// getting a realistic buy and sell
	    	buyingAffordance = affordedTradeAmount('buy', lowAsk);
	    	if( buyingAffordance == 0 ){
	    		lowAsk = asks.shift();
	    		continue;
	    	}
	    	sellingAffordance = affordedTradeAmount('sell', highBid);
	    	if( sellingAffordance == 0 ){
	    		highBid = bids.shift();
	    		continue;
	    	}
    	}
		lowAsk.buySell = 'buy';
		highBid.buySell = 'sell';

    	// we're in magic land now, buy and sell can happen and they're more than gtfo apart! Yey!
    	tradeAmount = _.min([buyingAffordance, sellingAffordance]);

    	if(tradeAmount === buyingAffordance){
    		arbitrades.push(lowAsk);
    		lowAsk = asks.shift();

    		arbitrades.push(_.extend(_.cloneDeep(highBid), {amount: tradeAmount}));
    		highBid.amount -= tradeAmount;
    	} else {
    		arbitrades.push(highBid);
    		highBid = bids.shift();

    		arbitrades.push(_.extend(_.cloneDeep(lowAsk), {amount: tradeAmount}));
    		lowAsk.amount -= tradeAmount;
    	}
    }
    return arbitrades;
}

/*
	Compress arbitrades so multiple on same exchange with same price get combined.
*/
function combineArbitrades(arbitrades){
	var processedArbitrades = [], combinations = [];

	while(arbitrades.length > 0){
		item = arbitrades.shift();
		combinations = _.remove( arbitrades, _.pick(item, ['buySell', 'deFactoPrice', 'exchange', 'currency']));
		_.each(combinations, function(comboItem){
			item.amount += comboItem.amount;
		});
		processedArbitrades.push(item);
	}
    return processedArbitrades;
}


trader.init().then(function () {
	trader.on('updated_spread_data', function(spread){
		addToEquivIndex(spread);
		var possibleArbitrages = spitArbitrage(1, true);
		if(possibleArbitrages.length > 0){
			var combined = combineArbitrades(possibleArbitrages);

			console.log('possible arbitrage: ', combined);

			var buys = _.remove(combined, {buySell:'buy'})
			var totalBuys = _.reduce(buys, function(sum, item){
				return sum + (item.deFactoPrice * item.amount)
			}, 0);

			var totalSells = _.reduce(combined, function(sum, item){
				return sum + (item.deFactoPrice * item.amount)
			}, 0);

			console.log('Buy for ', totalBuys, ' sell for ', totalSells, ' profit: ', totalSells-totalBuys, ' percent: ', (100*(totalSells-totalBuys) / totalSells).toFixed(2), '%');
			fs.appendFile('./log.txt', (new Date()).toTimeString() + ' Buy @ ' + buys[0].exchange + ' for ' + totalBuys + ' sell @ ' + combined[0].exchange +  ' for ' + totalSells + ' profit: ' + (totalSells-totalBuys) + ' percent: ' + (100*(totalSells-totalBuys) / totalSells).toFixed(2) + '% \n');
		}
	});

	ratesPromise.then(function(){
	    trader.watch('EUR');
	    trader.watch('USD');

		// Promise.all(_.map(_.keys(trader.RawSpreads), trader.getAllSpreads, trader)).then(function(){
		// 	console.log('got all spreads')

		// 	console.log(bestTrade('sell', 20));

		// });

	});
});
