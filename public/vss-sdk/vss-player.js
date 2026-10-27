



/**
 * element id 
 * example : <div id="player"></div>
 * id = player
 * var player= new VssPlayer('#player')
 * @param {*} ele 
 */


const playerStateIdle = 0;
const playerStatePlaying = 1;
const playerStatePausing = 2;


function VssPlayer(ele, callback) {
    this.ele = ele;
    this.playerState = playerStateIdle;
    this.session = -1;
    this.deviceID = "";
    this.callback = callback;

}





VssPlayer.prototype = {



    initCanvas: function () {
        var _div = document.querySelector(this.ele);

        if (this.canvasElement) {
            _div.removeChild(this.canvasElement);
        }
        this.canvasElement = document.createElement("canvas");
        this.canvasElement.height = _div.clientHeight;
        this.canvasElement.width = _div.clientWidth;
        _div.append(this.canvasElement);
    },
    /**
     * Live 
     * @param {*} ip  Streaming Server Ip
     * @param {*} prot  Streaming Server Prot 
     * @param {*} deviceID  deviceID 
     * @param {*} channel   channel
     * @param {*} stream  0 Sub stream / 1 Main stream
     * @param {*} openAudio   Whether to turn on the sound, true/false default : false 
     * @param {*} bufferTimeMs   Cache duration 
     * @param {*} userName  Current login username
     * @returns 
     */
    live: function (ip, prot, deviceID, channel, stream, openAudio = false, bufferTimeMs = 2500, userName = "admin") {

        if (this.playerState === playerStatePlaying) { return; }
        this.initCanvas();
        this.initSocketWorker();
        this.webglPlayer = new WebGLPlayer(this.canvasElement, {
            preserveDrawingBuffer: false,
        });
        this.session = +new Date();
        this.deviceID = deviceID;
        var playload = {
            "action": "3000",
            "payload":
            {
                "sessionID": this.session,
                "deviceID": deviceID,
                "channel": channel,
                "stream": stream,
                "bufferTimeMs": bufferTimeMs,
                "username": userName,
                "bussType": "1"
            }
        }
        this.wsConnect(this.wsUrl(ip, prot, "stream"), JSON.stringify(playload), this.session);
        this.playerState = playerStatePlaying;
        this.openAudio(openAudio)
        this.callback && this.callback({ status: "loading" })
    },
    /**
     * 
     * @param {*} ip  Server Ip
     * @param {*} prot  Server Prot 
     * @param {*} deviceID  deviceID 
     * @param {*} file   File
     * @param {*} openAudio  Whether to turn on the sound, true/false default : false 
     * @returns 
     */
    alarmFile: function (ip, prot, deviceID, file, openAudio = false) {

        if (this.playerState === playerStatePlaying) { return; }
        this.initCanvas();
        this.initSocketWorker();
        this.webglPlayer = new WebGLPlayer(this.canvasElement, {
            preserveDrawingBuffer: false,
        });
        this.session = +new Date();
        this.deviceID = deviceID;
        var playload = {
            "action": "3003",
            "payload": {
                "sessionID": this.session,
                "deviceID": deviceID,
                "startTime": "",
                "stopTime": "",
                "offset": "0",
                "fileName": file,
                "actionType": "1",
            }
        }
        this.wsConnect(this.wsUrl(ip, prot, "alarmserver"), JSON.stringify(playload), {
            deviceId: this.deviceID,
            sessionId: this.session,
        });
        this.playerState = playerStatePlaying;
        this.openAudio(openAudio)
        this.callback && this.callback({ status: "loading" })
    },

    /**
     * 
     * @param {*} ip  Server Ip
     * @param {*} prot  Server Prot 
     * @param {*} deviceID  deviceID 
     * @param {*} file  File
     * @param {*} openAudio  Whether to turn on the sound, true/false default : false 
     * @returns 
     */
    cloudVideoFile: function (ip, prot, deviceID, file, openAudio = false) {

        if (this.playerState === playerStatePlaying) { return; }
        this.initCanvas();
        this.initSocketWorker();
        this.webglPlayer = new WebGLPlayer(this.canvasElement, {
            preserveDrawingBuffer: false,
        });
        this.session = +new Date();
        this.deviceID = deviceID;
        var playload = {
            "action": "3003",
            "payload": {
                "sessionID": this.session,
                "deviceID": deviceID,
                "startTime": "",
                "stopTime": "",
                "offset": "0",
                "fileName": file,
                "actionType": "1",
            }
        }
        this.wsConnect(this.wsUrl(ip, prot, "alarmserver"), JSON.stringify(playload), {
            deviceId: this.deviceID,
            sessionId: this.session,
        });
        this.playerState = playerStatePlaying;
        this.openAudio(openAudio)
        this.callback && this.callback({ status: "loading" })
    },
    /**
     * 
     * @param {*} ip  Server Ip
     * @param {*} prot  Server Prot 
     * @param {*} deviceID  deviceID 
     * @param {*} file  File
     * @param {*} openAudio  Whether to turn on the sound, true/false default : false 
     * @returns 
     */
    autoDownloadServerFile: function (ip, prot, deviceID, file, openAudio = false) {

        if (this.playerState === playerStatePlaying) { return; }
        this.initCanvas();
        this.initSocketWorker();
        this.webglPlayer = new WebGLPlayer(this.canvasElement, {
            preserveDrawingBuffer: false,
        });
        this.session = +new Date();
        this.deviceID = deviceID;
        var playload = {
            "action": "3003",
            "payload": {
                "sessionID": this.session,
                "deviceID": this.deviceID,
                "startTime": "",
                "stopTime": "",
                "offset": "0",
                "fileName": file,
                "actionType": "1"
            }
        }
        this.wsConnect(this.wsUrl(ip, prot, "autoserver"), JSON.stringify(playload), {
            deviceId: this.deviceID,
            sessionId: this.session,
        });
        this.playerState = playerStatePlaying;
        this.openAudio(openAudio)
        this.callback && this.callback({ status: "loading" })
    },


    /**
     * 
     * @param {*} ip  Server Ip
     * @param {*} prot  Server Prot 
     * @param {*} deviceID   deviceID 
     * @param {*} channel  channel
     * @param {*} start_date_time  start datetime
     * @param {*} end_date_time  end datetime
     * @param {*} openAudio  Whether to turn on the sound, true/false default : false 
     * @param {*} userName  Current login username
     * @returns 
     */
    playback: function (ip, prot, deviceID, channel, start_date_time, end_date_time, openAudio = false, stream = 1, userName = "admin") {

        if (this.playerState === playerStatePlaying) { return; }
        this.initCanvas();
        this.initSocketWorker();
        this.webglPlayer = new WebGLPlayer(this.canvasElement, {
            preserveDrawingBuffer: false,
        });
        this.session = +new Date();
        this.deviceID = deviceID;
        var playload = {
            "action": "3003",
            "payload": {
                "sessionID": this.session,
                "deviceID": deviceID,
                "channel": channel,
                "startTime": start_date_time,
                "stopTime": end_date_time,
                "offset": "0",
                "fileName": "",
                "actionType": "1",
                "username": userName,
                "bussType": "4",
                "stream": stream
            }
        }
        this.wsConnect(this.wsUrl(ip, prot, "stream"), JSON.stringify(playload), {
            deviceId: this.deviceID,
            sessionId: this.session,
            channel: channel
        });
        this.playerState = playerStatePlaying;
        this.openAudio(openAudio)
        this.callback && this.callback({ status: "loading" })
    },

    /**
     * 
     * @param {*} speed 0,  1 ,2 , 4 ,8 ,16
     */
    playbackSpeed: function (speed) {
        if (this.playerState !== playerStatePlaying) {
            return;
        }
        const objData = {
            t: KWebSocket_playControl,
            d: 3,
            o: speed,
        };
        this.socketWorker.postMessage(objData);
        this.callback && this.callback({ status: "speed " + speed });
    },
    /**
     * 
     * @param {*} openAudio true : On   false : Off
     */
    openAudio: function (openAudio) {
        if (openAudio == true) {
            this.pcmPlayer = new PCMPlayer({
                encoding: "16bitInt",
                channels: 1,
                sampleRate: 8000,
                flushingTime: 200,
            });
            this.callback && this.callback({ status: "audio on" })
        } else {
            this.pcmPlayer = null;
            this.callback && this.callback({ status: "audio off" })
        }
    },
    resumePlay: function () {
        if (this.playerState == playerStatePausing) {

            const objData = {
                t: KWebSocket_playControl,
                d: 2,
                o: 0,
            };
            this.socketWorker.postMessage(objData);
            this.playerState = playerStatePlaying;
            this.callback && this.callback({ status: "playing" });
        }

    },
    pause: function () {

        if (this.playerState == playerStatePlaying) {

            const objData = {
                t: KWebSocket_playControl,
                d: 1,
                o: 0,
            };
            this.socketWorker.postMessage(objData);

            this.playerState = playerStatePausing;
            this.callback && this.callback({ status: "pause" });
        }


    },
    stop: function () {
        if (this.playerState != playerStateIdle) {
            this.playerState = playerStateIdle;
            var objData = {
                t: KWebSocket_StreamStop,
            };
            this.socketWorker.postMessage(objData);
            this.webglPlayer.unInit();
            this.webglPlayer = null;
            this.callback && this.callback({ status: "stop" })
        }
        this.onStreamStop();
        this.videoWidth = undefined;
        var _div = document.querySelector(this.ele);
        if (this.canvasElement) {
            _div.removeChild(this.canvasElement);
        }
        this.canvasElement = null;
        this.playerState = playerStateIdle;

    },
    onStreamStop: function (evt) {
        this.socketWorker.terminate();
    },
    onVideoFrame: function (frame) {

        if (!this.videoWidth) {
            this.videoWidth = frame.w;
            this.videoHeight = frame.h;
            this.yLength = this.videoWidth * this.videoHeight;
            this.uvLength = (this.videoWidth / 2) * (this.videoHeight / 2);
            this.callback && this.callback({ status: "playing" })
        }

        var data = new Uint8Array(frame.d);
        if (this.webglPlayer)
            this.webglPlayer.renderFrame(
                data,
                this.videoWidth,
                this.videoHeight,
                this.yLength,
                this.uvLength
            );
        this.currentTime = frame.ts;

    },

    onAudioFrame: function (frame) {

        if (this.pcmPlayer) {
            if (this.pcmSampleRate == 24000) {
                this.pcmPlayer.feed(this.Pcm8t24(frame.d));
                return true;
            }
            this.pcmPlayer.feed(frame.d);
        }

    },

    wsUrl: function (ip, prot, streamServerType) {

        let _proc = window.location.protocol.toLowerCase();
        if (_proc == "http:") {
            return `ws://${ip}:${prot}/${streamServerType}`;
        }
        if (ip == window.location.hostname) {
            return `wss://${ip}:${prot}/${streamServerType}?ipaddr=127.0.0.1`;
        }
        return `wss://${window.location.hostname}:${prot}/${streamServerType}?ipaddr=${ip}`;

    },

    initSocketWorker: function () {
        var self = this;
        this.socketWorker = new Worker("./js/hwwebsocket.js");

        this.socketWorker.onmessage = function (evt) {
            var objData = evt.data;
            switch (objData.t) {
                case kInitDecoderRsp:
                    self.onStreamStart(objData);
                    break;
                case KWebSocket_Close:
                    self.onStreamStop();
                    break;
                case KWebSocket_Message:
                    self.onStream(objData.d);
                    break;
                case KWebSocket_Open:
                    break;
                case kVideoFrame:
                    self.onVideoFrame(objData);
                    break;
                case kAudioFrame:
                    self.onAudioFrame(objData);
                    break;
            }
        };

    },
    wsConnect: function (url, playload, session) {

        var objData = {
            t: KWebSocket_ConnectReq,
            u: url,
            s: playload,
            ob: session
        };
        this.socketWorker.postMessage(objData);

    }



};





