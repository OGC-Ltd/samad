var isNeedLoaded = true;

Module = {
    onRuntimeInitialized: function() {
        isNeedLoaded = false;
        // console.log("wasm load success");
    },
};

importScripts("libdecoder.js");

function WebDecoder() {
    this.cacheBuffer = null;
    this.videoCallback = null;
    this.audioCallback = null;
    this.codec = null;
}
// h264 27
// h265 173
WebDecoder.prototype.openDecoder = function() {
    if (this.codec == null) {
        return -1;
    }
    var ret = Module._jsOpenDecoder(this.codec, 173);
    if (ret == 0) {
        this.cacheBuffer = Module._malloc(65536);
    }
    return ret;
};

// 初始化解码器
WebDecoder.prototype.init = function() {
    if (isNeedLoaded) {
        return;
    }
    this.videoCallback = Module.addFunction(function(
            buff,
            format,
            width,
            heigth,
            size,
            timestamp
        ) {
            var outArray = Module.HEAPU8.subarray(buff, buff + size);
            var data = new Uint8Array(outArray);
            var objData = {
                t: kVideoFrame,
                f: format,
                w: width,
                h: heigth,
                l: size,
                d: data,
                ts: timestamp,
            };
            self.postMessage(objData, [objData.d.buffer]);
        },
        "viid");
    this.audioCallback = Module.addFunction(function(buff, size) {
        var outArray = Module.HEAPU8.subarray(buff, buff + size);
        var data = new Uint8Array(outArray);
        var objData = {
            t: kAudioFrame,
            d: data,
        };
        self.postMessage(objData, [objData.d.buffer]);
    }, "viid");
    this.codec = Module._jsNewDecoder(this.videoCallback, this.audioCallback);
    //this.cacheBuffer = Module._malloc(6553600);
    this.cacheBuffer = Module._malloc(600 * 1024);
    return this.codec;
};

// 解码一帧数据
WebDecoder.prototype.decodeOnepacket = function(frameData) {
    if (null == this.codec)
        this.init();
    if (isNeedLoaded) {
        return;
    }

    let packetindex = 0; // howen media header
    packetindex += frameData[2];
    packetindex += (frameData[3] << 8);

    //if( frameData[0] ==3 ) 
    	//return;

     //if ( frameData[0] ==3 )
     //    console.log("index=" + packetindex + ";  frame data len " + frameData.length + " type=" + frameData[0]);


    Module.HEAPU8.set(frameData, this.cacheBuffer);
    return Module._jsDecodecOnepacket(this.codec, this.cacheBuffer, frameData.length);

};

// 释放解码器资源
WebDecoder.prototype.close = function() {
    if (this.codec) Module._jsReleaseDecoder(this.codec);
};