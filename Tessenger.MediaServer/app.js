
"use static"

// Import packages
const express = require("express")
const fs = require("fs")
const https = require("http")
const socket = require("socket.io")
const mediasoup = require("mediasoup")
const config = require('./Js Class/config')
const path = require('path')
const Room = require('./Js Class/Room')
const Peer = require('./Js Class/Peer')

// Server configuration
var PORT = 3001;
var url = "https://vocal-subtle-kangaroo.ngrok-free.app"
var options = {
    key: fs.readFileSync("ssl/key.pem"),
    cert: fs.readFileSync("ssl/cert.pem")
}

// Create Express app and HTTPS server
var app = express()
var server = https.createServer( app)

// Initialize socket.io with CORS settings
var io = socket(server, {
    cors: {
        origin: url,
        methods: ["GET", "POST"],
    }
})

// Start server
server.listen(PORT, () => {
    console.log("Server is running on port " + PORT)
})

// Mediasoup workers and room list
let workers = []
let nextMediasoupWorkerIdx = 0
let roomList = new Map()

// Create Mediasoup workers
;(async () => { await createWorkers() })()

async function createWorkers() {
    let { numWorkers } = config.mediasoup

    for (let i = 0; i < numWorkers; i++) {
        let worker = await mediasoup.createWorker({
            logLevel: config.mediasoup.worker.logLevel,
            logTags: config.mediasoup.worker.logTags,
            rtcMinPort: config.mediasoup.worker.rtcMinPort,
            rtcMaxPort: config.mediasoup.worker.rtcMaxPort
        })

        worker.on('died', () => {
            console.error('mediasoup worker died, exiting in 2 seconds... [pid:%d]', worker.pid)
            setTimeout(() => process.exit(1), 2000)
        })
        workers.push(worker)
        console.info('mediasoup Worker pid: ', worker.pid);

        setInterval(async () => {
            const usage = await worker.getResourceUsage();
            console.info('mediasoup Worker resource usage [pid:%d]: %o', worker.pid, usage);
        }, 120000);
    }
}

// Get the next Mediasoup worker
function getMediasoupWorker() {
    const worker = workers[nextMediasoupWorkerIdx]
    if (++nextMediasoupWorkerIdx === workers.length) nextMediasoupWorkerIdx = 0
    return worker
}

// Handle socket.io connections
io.on('connection', (socket) => {
    console.log("New User Connecting: ", socket.id)

    // Handle room creation
    socket.on('createRoom', async ({ room_id }, callback) => {
        if (roomList.has(room_id)) {
            callback('already exists')
        } else {
            console.log('Created room', { room_id: room_id })
            let worker = await getMediasoupWorker()
            roomList.set(room_id, new Room(room_id, worker, io))
            callback(room_id)
        }
    })

    // Handle user joining a room
    socket.on('join', ({ room_id, name }, cb) => {
        console.log('User joined', {
            room_id: room_id,
            name: name
        })

        if (!roomList.has(room_id)) {
            return cb({
                error: 'Room does not exist'
            })
        }

        roomList.get(room_id).addPeer(new Peer(socket.id, name))
        socket.room_id = room_id

        cb(roomList.get(room_id).toJson())
    })

    // Handle request for producers
    socket.on('getProducers', () => {
        if (!roomList.has(socket.room_id)) return
        console.log('Get producers', { name: `${roomList.get(socket.room_id).getPeers().get(socket.id).name}` })

        let producerList = roomList.get(socket.room_id).getProducerListForPeer()
        socket.emit('newProducers', producerList)
    })

    // Handle request for router RTP capabilities
    socket.on('getRouterRtpCapabilities', (_, callback) => {
        console.log('Get RouterRtpCapabilities', {
            name: `${roomList.get(socket.room_id).getPeers().get(socket.id).name}`
        })

        try {
            callback(roomList.get(socket.room_id).getRtpCapabilities())
        } catch (e) {
            callback({
                error: e.message
            })
        }
    })

    // Handle creation of WebRTC transport
    socket.on('createWebRtcTransport', async (_, callback) => {
        console.log('Create webrtc transport', {
            name: `${roomList.get(socket.room_id).getPeers().get(socket.id).name}`
        })

        try {
            const { params } = await roomList.get(socket.room_id).createWebRtcTransport(socket.id)
            callback(params)
        } catch (err) {
            console.error(err)
            callback({
                error: err.message
            })
        }
    })

    // Handle connection of transport
    socket.on('connectTransport', async ({ transport_id, dtlsParameters }, callback) => {
        console.log('Connect transport', { name: `${roomList.get(socket.room_id).getPeers().get(socket.id).name}` })

        if (!roomList.has(socket.room_id)) return
        await roomList.get(socket.room_id).connectPeerTransport(socket.id, transport_id, dtlsParameters)

        callback('success')
    })

    // Handle production of media
    socket.on('produce', async ({ kind, rtpParameters, producerTransportId }, callback) => {
        if (!roomList.has(socket.room_id)) {
            return callback({ error: 'not is a room' })
        }

        let producer_id = await roomList.get(socket.room_id).produce(socket.id, producerTransportId, rtpParameters, kind)

        console.log('Produce', {
            type: `${kind}`,
            name: `${roomList.get(socket.room_id).getPeers().get(socket.id).name}`,
            id: `${producer_id}`
        })

        callback({
            producer_id
        })
    })

    // Handle consumption of media
    socket.on('consume', async ({ consumerTransportId, producerId, rtpCapabilities }, callback) => {
        let params = await roomList.get(socket.room_id).consume(socket.id, consumerTransportId, producerId, rtpCapabilities)

        console.log('Consuming', {
            name: `${roomList.get(socket.room_id) && roomList.get(socket.room_id).getPeers().get(socket.id).name}`,
            producer_id: `${producerId}`,
            consumer_id: `${params.id}`
        })

        callback(params)
    })

    // Handle resuming of media
    socket.on('resume', async (data, callback) => {
        await consumer.resume()
        callback()
    })

    // Handle request for room info
    socket.on('getMyRoomInfo', (_, cb) => {
        cb(roomList.get(socket.room_id).toJson())
    })

    // Handle user disconnection
    socket.on('disconnect', () => {
        console.log('Disconnect', {
            name: `${roomList.get(socket.room_id) && roomList.get(socket.room_id).getPeers().get(socket.id).name}`
        })

        if (!socket.room_id) return
        roomList.get(socket.room_id).removePeer(socket.id)
    })

    // Handle producer closure
    socket.on('producerClosed', ({ producer_id }) => {
        console.log('Producer close', {
            name: `${roomList.get(socket.room_id) && roomList.get(socket.room_id).getPeers().get(socket.id).name}`
        })

        roomList.get(socket.room_id).closeProducer(socket.id, producer_id)
    })

    // Handle user exiting a room
    socket.on('exitRoom', async (_, callback) => {
        console.log('Exit room', {
            name: `${roomList.get(socket.room_id) && roomList.get(socket.room_id).getPeers().get(socket.id).name}`
        })

        if (!roomList.has(socket.room_id)) {
            callback({
                error: 'not currently in a room'
            })
            return
        }

        await roomList.get(socket.room_id).removePeer(socket.id)
        if (roomList.get(socket.room_id).getPeers().size === 0) {
            roomList.delete(socket.room_id)
        }

        socket.room_id = null
        callback('successfully exited room')
    })
})
