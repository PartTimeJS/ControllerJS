'use strict';

const AssignmentController = require('./assignment-controller.js');
const Device = require('../models/device.js');
const Instance = require('../models/instance.js');
const { AutoInstanceController, AutoType } = require('./instances/auto.js');
const { CircleInstanceController, CircleType } = require('./instances/circle.js');
const IVInstanceController = require('./instances/iv.js');
const RedisClient = require('../services/redis.js');
const Pokemon = require('../models/pokemon.js');

const InstanceType = {
    CirclePokemon: 'circle_pokemon',
    CircleRaid: 'circle_raid',
    CircleSmartRaid: 'circle_smart_raid',
    AutoQuest: 'auto_quest',
    PokemonIV: 'pokemon_iv'
};

class InstanceController {
    static instance = new InstanceController();

    constructor() {
        this.devices = {};
        this.instances = {};

        this.init().then(x => x).catch(err => {
            console.error('[InstanceController] Error:', err);
        });
    }

    async init() {
        let instances = await Instance.getAll();
        let devices = await Device.getAll();
        console.log('[InstanceController] Starting instances...');
        for (let i = 0; i < instances.length; i++) {
            let inst = instances[i];
            console.log(`[InstanceController] Starting ${inst.name}...`);
            this.addInstance(inst);
            console.log(`[InstanceController] Started ${inst.name}`);
            let filtered = devices.filter(x => x.instanceName === inst.name);
            for (let j = 0; j < filtered.length; j++) {
                let device = filtered[j];
                this.addDevice(device);
            }
        }
        console.log('[InstanceController] Done starting instances');

        // Register redis client subscription on event handler
        await RedisClient.onEvent('message', (channel, message) => {
            //console.log('[Redis] Event:', channel, message);
            switch (channel) {
                case 'pokemon_add_queue':
                    this.gotPokemon(new Pokemon(JSON.parse(message)));
                    break;
            }
        });
        await RedisClient.subscribe('pokemon_add_queue');
    }

    getInstanceController(uuid) {
        let device = this.devices[uuid];
        let instanceName = device.instanceName;
        if (!device && !instanceName) {
            return null;
        }
        return this.getInstanceControllerByName(instanceName);
    }

    getInstanceControllerByName(name) {
        return this.instances[name];
    }

    addInstance(instance) {
        let instanceController;
        switch (instance.type) {
            case InstanceType.CirclePokemon:
            case InstanceType.CircleRaid:
            case InstanceType.CircleSmartRaid: {
                let coordsArray = [];
                if (instance.data['area']) {
                    coordsArray = instance.data['area'];
                } else {
                    let coords = instance.data['area'];
                    for (let coord in coords) {
                        coordsArray.push({ lat: coord.lat, lon: coord.lon });
                    }
                }
                let minLevel = parseInt(instance.data['min_level'] || 0);
                let maxLevel = parseInt(instance.data['max_level'] || 29);
                switch (instance.type) {
                    case InstanceType.CirclePokemon:
                        instanceController = new CircleInstanceController(instance.name, coordsArray, CircleType.Pokemon, minLevel, maxLevel);
                        break;
                    case InstanceType.CircleRaid:
                        instanceController = new CircleInstanceController(instance.name, coordsArray, CircleType.Raid, minLevel, maxLevel);
                        break;
                    case InstanceType.CircleSmartRaid:
                        // TODO: Smart Raid instance
                        break;
                }
                break;
            }
            case InstanceType.AutoQuest:
            case InstanceType.PokemonIV: {
                let areaArray = [];
                if (instance.data['area']) {
                //    areaArray = instance.data['area']; //[[Coord]]
                //} else {
                    let areas = instance.data['area']; //[[[String: Double]]]
                    for (let i = 0; i < areas.length; i++) {
                        let coords = areas[i];
                        for (let j = 0; j < coords.length; j++) {
                            let coord = coords[j];
                            while (areaArray.length !== i + 1) {
                                areaArray.push([]);
                            }
                            areaArray[i].push({ lat: coord['lat'], lon: coord['lon'] });
                        }
                    }
                }
                let timezoneOffset = parseInt(instance.data['timezone_offset'] || 0);    
                let areaArrayEmptyInner = [];//[[[CLLocationCoordinate2D]]]()
                for (let i = 0; i < areaArray.length; i++) {
                    let coords = areaArray[i];
                    let polyCoords = [];
                    for (let j = 0; j < coords.length; j++) {
                        let coord = coords[j];
                        polyCoords.push([coord['lon'], coord['lat']]);
                    }
                    areaArrayEmptyInner.push([polyCoords]);
                }

                let minLevel = parseInt(instance.data['min_level'] || 0);
                let maxLevel = parseInt(instance.data['max_level'] || 29);
                if (instance.type === InstanceType.PokemonIV) {
                    let pokemonList = instance.data['pokemon_ids'];
                    let ivQueueLimit = parseInt(instance.data['iv_queue_limit'] || 100);
                    instanceController = new IVInstanceController(instance.name, areaArrayEmptyInner, pokemonList, minLevel, maxLevel, ivQueueLimit);
                } else {
                    let spinLimit = parseInt(instance.data['spin_limit'] || 500);
                    instanceController = new AutoInstanceController(instance.name, areaArrayEmptyInner, AutoType.Quest, timezoneOffset, minLevel, maxLevel, spinLimit);
                }
                break;
            }
        }
        this.instances[instance.name] = instanceController;
    }

    reloadAll() {
        for (let i = 0; i < this.instances.length; i++) {
            let instance = this.instances[i];
            instance.reload();
        }
    }

    removeInstance(instance) {
        this.removeInstanceByName(instance.name);
    }

    removeInstanceByName(name) {
        this.instances[name].stop();
        this.instances[name] = null;
        for (let device in this.devices.filter(x => x.instanceName === name)) {
            this.devices[device.uuid] = null;
        }
        AssignmentController.instance.setup();
    }

    addDevice(device) {
        if (!this.devices[device.uuid]) {
            this.devices[device.uuid] = device;
        }
    }

    removeDevice(device) {
        this.removeDeviceByName(device.uuid);
    }

    reloadDevice(newDevice, oldDeviceUUID) {
        this.removeDeviceByName(oldDeviceUUID);
        this.addDevice(newDevice);
    }

    removeDeviceByName(name) {
        /*delete*/ this.devices[name] = null;
        AssignmentController.instance.setup();
    }

    getDeviceUUIDsInInstance(instanceName) {
        let uuids = [];
        for (let i = 0; i < this.devices.length; i++) {
            let key = this.devices[i];
            let device = this.devices[key];
            if (device.instanceName === instanceName) {
                uuids.push(key);
            }
        }
        return uuids;
    }

    gotPokemon(pokemon) {
        for (let inst in this.instances) {
            let instObj = this.instances[inst];
            if (instObj instanceof IVInstanceController) {
                try {
                    instObj.addPokemon(pokemon);
                } catch (err) {
                    console.error('Failed to add pokemon to IV queue:', instObj.name, err);
                }
            }
        }
    }
}

module.exports = InstanceController;