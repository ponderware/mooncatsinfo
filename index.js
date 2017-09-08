const fs = require('fs');
const async = require('async');
const zlib = require('zlib');
const Canvas = require('canvas');
const generateMoonCat = require("mooncatparser");
const Web3 = require('web3');
const http = require('http');

// contract ABI
const ABI = require("./abi");

// image sizes
const fullSize = 10;
const thumbSize = 2;

const port = process.env.MOONCATRESCUE_PORT || 3000;
const contractAddress = process.env.MOONCATRESCUE_CONTRACT || "0x60cd862c9c687a9de49aecdc3a99b74a4fc54ab6";
const providerURL = process.env.MOONCATRESCUE_RPC || "http://127.0.0.1:3000";
const refreshDelay = 20 * 1000;

if(!contractAddress) throw "Contract Address not found. Set MOONCATRESCUE_CONTRACT to the address of the contract."

if(!providerURL) throw "Contract Address not found. Set MOONCATRESCUE_RPC to the url of the rpc provider.";

var web3 = new Web3()
web3.setProvider(new Web3.providers.HttpProvider(providerURL));

function loadMoonCatRescueContract(address){
    var contract = web3.eth.contract(ABI);
    return contract.at(address);
}

const mcrContract = loadMoonCatRescueContract(contractAddress);

// Data Handling

var catData = {order: [],
	       cats: {}};

var fetchCount = 0;
var remainingCats = "?";
var imageCache = {}
var cachedData = JSON.stringify(catData);
var compressedData;

function zipCache(){
    zlib.gzip(cachedData, function(err, result){
	if(err) return console.log(err);
	compressedData = result;
    })
}

zipCache();

function drawCat(catId){
    if(imageCache[catId]){
	return imageCache[catId];
    }

    var data = generateMoonCat(catId);
    var canvasFull = new Canvas(fullSize * data.length, fullSize * data[0].length);
    var canvasThumb = new Canvas(thumbSize * data.length, thumbSize * data[0].length);

    var ctxFull = canvasFull.getContext('2d');
    var ctxThumb = canvasThumb.getContext('2d');
    for (var i = 0; i < data.length; i++) {
	for (var j = 0; j < data[i].length; j++) {
	    var color = data[i][j];
	    if (color) {
		ctxFull.fillStyle = color;
		ctxThumb.fillStyle = color;
		ctxFull.fillRect(i * fullSize, j * fullSize, fullSize, fullSize);
		ctxThumb.fillRect(i * thumbSize, j * thumbSize, thumbSize, thumbSize);
	    }
	}
    }

    var result = {image: canvasFull.toBuffer(),
		  thumb: canvasThumb.toDataURL()};

    imageCache[catId] = result;

    return result;
}

function getCatImage(catId){
    if(imageCache[catId]){
	return imageCache[catId].image;
    }

}

function handleCatData(err, data){
    fetchCount++;
    if(err) {
	console.log(err);
    } else {
	catData = data;
	cachedData = JSON.stringify(catData);
	zipCache();
    }
    console.log("fetch #", fetchCount, err ? "failed." : "complete.", catData.length, "cats loaded.");
    setTimeout(function(){
	loadCatData(handleCatData);
    }, refreshDelay);
}


function loadCatData (cb){
    var bar = {
	start: Date.now(),
	ticks: 0
    };
    bar.tick = function tickBar(){
	bar.ticks++;
	var seconds = Math.floor((Date.now() - bar.start) / 100) / 10;
	if(bar.ticks == 1){
	    process.stdout.write("fetching... [1] 0s");
	}else if(bar.ticks == 7){
	    console.log(`   [${bar.ticks}] ${seconds}s    done.`);
	}else{
	    process.stdout.write(`   [${bar.ticks}] ${seconds}s`)
	}
    }

    function tick(cb){
	return function(err, result){
	    bar.tick();
	    cb(err, result);
	}
    }

    bar.tick();

    async.parallel([
	function(cb){
	    mcrContract.getCatIds(tick(cb));
	},
	function(cb){
	    mcrContract.getCatNames(tick(cb));
	},
	function(cb){
	    mcrContract.getCatOwners(tick(cb));
	},
	function(cb){
	    mcrContract.getCatOfferPrices(tick(cb));
	},
	function(cb){
	    mcrContract.getCatRequestPrices(tick(cb));
	}], function (err, results){
	    if(err) return cb(err);
	    var assembled = {};
	    for(var i = 0; i < results[0].length; i++){
		var offerPriceWei = results[3][i];
		var requestPriceWei = results[4][i];
		var offerPrice = parseFloat(web3.fromWei(offerPriceWei, "ether"), 10);
		var requestPrice = parseFloat(web3.fromWei(requestPriceWei, "ether"), 10);
		var catId = results[0][i];
		var cat = {number: i,
			   id: catId,
			   name: web3.toUtf8(results[1][i]),
			   owner: results[2][i],
			   offered: !(offerPriceWei.eq(0)),
			   offerPrice: offerPrice,
			   requested: !(requestPriceWei.eq(0)),
			   requestPrice: requestPrice,
			   thumb: drawCat(catId).thumb}
		assembled[catId] = cat;
	    }
	    var result = results[0].map(function(id){return assembled[id]});
	    bar.tick();
	    cb(null, result);
	})

}

function loadRemainingCatCount(){
    mcrContract.remainingCats(function(err, result){
	if(result){
	    console.log("remaining cats:", result.toString());
	    remainingCats = result.toString();
	}
	setTimeout(loadRemainingCatCount, refreshDelay);
    })
}


// Server

function requestHandler(request, response) {
    var path = request.url.split("/").filter((x)=>{return x})
    var catImage = getCatImage(path[0]);
    if(path[0] == "remaining"){ // respond with remainingCats
	response.setHeader('Access-Control-Allow-Origin', '*');
	response.setHeader('Content-Type', 'application/json');
	response.write("" + remainingCats, 'utf8')
	response.end()
    } else if(catImage){ // respond with fullsize cat image;
	response.setHeader('Access-Control-Allow-Origin', '*');
	response.setHeader('Content-Type', 'image/png');;
	response.write(catImage, 'binary');
	response.end();
    }else{ // respond with compressed cat data
	response.setHeader('Access-Control-Allow-Origin', '*');
	response.setHeader('Content-Type', 'application/json');
	response.setHeader('Content-Encoding', 'gzip');
	response.write(compressedData, 'binary');

	response.end();
    }
}

const server = http.createServer(requestHandler)

server.listen(port, (err) => {
    if (err) {
	return console.log('failed to start server', err)
    }
    console.log(`listening on port: ${port}`)
})


// Start

console.log("contract address:", contractAddress);
console.log("provider url:", providerURL);

setTimeout(function(){
    loadCatData(handleCatData);
    loadRemainingCatCount();
}, 1000)
