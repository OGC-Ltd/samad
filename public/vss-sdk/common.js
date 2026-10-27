const KInitWasm_Ok = 0;

const KError_None = 0;
const KError_InitDecoder = 1;
const KError_FFmpegDecodec = 2;
const KError_AllocAVFrame = 3;
const kError_InvalidParam = 4;
const kError_InvalidData = 5;
const kError_InvalidFormat = 6;

//Decoder request.
const kInitDecoderReq = 0;
const kUninitDecoderReq = 1;
const kOpenDecoderReq = 2;
const kCloseDecoderReq = 3;
const kFeedDataReq = 4;
const kStartDecodingReq = 5;
const kPauseDecodingReq = 6;

//Decoder response.
const kInitDecoderRsp = 0;
const kUninitDecoderRsp = 1;
const kOpenDecoderRsp = 2;
const kCloseDecoderRsp = 3;
const kVideoFrame = 4;
const kAudioFrame = 5;
const kStartDecodingRsp = 6;
const kPauseDecodingRsp = 7;
const kDecodeFinishedEvt = 8;

// websocket request
const KWebSocket_InitReq = 9;
const KWebSocket_ConnectReq = 10;


// websocket response
const KWebSocket_InitRsp = 9;
const KWebSocket_ConnectRsq = 10;

const KWebSocket_StreamStart = 11;
const KWebSocket_StreamStop = 12;
const KWebSocket_Open = 13;
const KWebSocket_Error = 14;
const KWebSocket_Close = 15;
const KWebSocket_Message = 16;
const KWebSocket_OpenAudio = 17;

// websocket send out data 
const KWebSocket_sendG726EncData = 18;
const kAudioPCMData = 19;
const kAudioEncFrame = 20;

const KWebSocket_playControl = 21; //播放控制指令



const g_cnfServerSSLPort = 36301;
const cnfAudioSampleRate = 8000; //采样率
const cnfAudioSampleBits = 16; // 深度
const cnfAudioSamplePCMLen = 640; // pcm frame len

function Logger(module) {
    this.module = module;
}

Logger.prototype.log = function(line) {
    //console.log(this.currentTimeStr() + this.module + " " + line);
};

Logger.prototype.logError = function(line) {
    //console.log(this.currentTimeStr() + this.module + " ERROR " + line);
};

Logger.prototype.logInfo = function(line) {
    //console.log(this.currentTimeStr() + this.module + " INFO " + line);
};

Logger.prototype.logDebug = function(line) {
    // console.log(this.currentTimeStr() + this.module + " DEBUG " + line); 
};

Logger.prototype.currentTimeStr = function() {
    var now = new Date(Date.now());
    var year = now.getFullYear();
    var month = now.getMonth() + 1;
    var day = now.getDate();
    var hour = now.getHours();
    var min = now.getMinutes();
    var sec = now.getSeconds();
    // var ms = now.getMilliseconds();
    return year + "-" + month + "-" + day + " " + hour + ":" + min + ":" + sec + " ";
};