// Vehicle fleets for all 5 companies.



const VEHICLES = [
  {
    id: "KBU 123A", driver: "T. Ochieng", lat: -1.2921, lng: 36.8219,
    location: "Nairobi CBD, Nairobi",
    departure: "Sukari Industries, Thika", departureLat: -1.0332, departureLng: 37.0693,
    destination: "Mombasa Port Depot",    destinationLat: -4.0435, destinationLng: 39.6682,
    status: "ok", speed: 72, speedLimit: 80, engine: "on", fuelConsumption: 14.2, geofence: "inside", cargo: "Processed Sugar", weight: 38,
  },
  {
    id: "KDA 456B", driver: "J. Mutua", lat: -4.0435, lng: 39.6682,
    location: "Mombasa Port, Coast",
    departure: "Mombasa Refinery",        departureLat: -3.8667, departureLng: 39.6500,
    destination: "Nairobi CBD Warehouse", destinationLat: -1.2921, destinationLng: 36.8219,
    status: "speeding", speed: 112, speedLimit: 80, engine: "on", fuelConsumption: 18.7, geofence: "inside", cargo: "Processed Sugar", weight: 42,
  },
  {
    id: "KBG 234D", driver: "P. Kipchoge", lat: -0.1022, lng: 34.7617,
    location: "Kisumu City, Nyanza",
    departure: "Kisumu Sugar Mill",        departureLat: -0.1022, departureLng: 34.7617,
    destination: "Nakuru Depot #3",        destinationLat: -0.3031, destinationLng: 36.0800,
    status: "ok", speed: 65, speedLimit: 80, engine: "on", fuelConsumption: 13.1, geofence: "inside", cargo: "Processed Sugar", weight: 35,
  },
  {
    id: "KDC 890F", driver: "M. Njoroge", lat: -0.3031, lng: 36.0800,
    location: "Nakuru Town, Rift Valley",
    departure: "Nakuru Farm Gate",         departureLat: -0.5500, departureLng: 35.8500,
    destination: "Sukari Industries, Thika",  destinationLat: -1.0332, destinationLng: 37.0693,
    status: "ok", speed: 58, speedLimit: 80, engine: "on", fuelConsumption: 12.8, geofence: "outside", cargo: "Raw Sugar Cane", weight: 40,
  },
  {
    id: "KDF 123J", driver: "R. Koech", lat: 0.5143, lng: 35.2698,
    location: "Eldoret, Uasin Gishu",
    departure: "Eldoret Grain Store",      departureLat: 0.5143, departureLng: 35.2698,
    destination: "Kisumu Processing Plant",destinationLat: -0.1022, destinationLng: 34.7617,
    status: "ok", speed: 0, speedLimit: 80, engine: "off", fuelConsumption: 0, geofence: "inside", cargo: "Raw Sugar Cane", weight: 36,
  },
  {
    id: "KBP 789L", driver: "F. Mwangi", lat: -3.2138, lng: 40.1169,
    location: "Malindi, Kilifi County",
    departure: "Malindi Farm",             departureLat: -3.2138, departureLng: 40.1169,
    destination: "Sukari Industries, Thika",     destinationLat: -1.0332, destinationLng: 37.0693,
    status: "theft", speed: 0, speedLimit: 80, engine: "on", fuelConsumption: 8.9, geofence: "outside", cargo: "Raw Sugar Cane", weight: 15,
  },
  {
    id: "KBV 012M", driver: "G. Wekesa", lat: -0.6817, lng: 34.7667,
    location: "Kisii Town, South Nyanza",
    departure: "Kisii Sugar Cane Fields",  departureLat: -0.6817, departureLng: 34.7667,
    destination: "Kisumu Sugar Mill",      destinationLat: -0.1022, destinationLng: 34.7617,
    status: "ok", speed: 48, speedLimit: 80, engine: "on", fuelConsumption: 11.4, geofence: "inside", cargo: "Raw Sugar Cane", weight: 33,
  },
  {
    id: "KBW 678P", driver: "C. Wambu", lat: -0.4532, lng: 39.6461,
    location: "Garissa Town, North Eastern",
    departure: "Garissa Depot",            departureLat: -0.4532, departureLng: 39.6461,
    destination: "Sukari Industries, Thika",  destinationLat: -1.0332, destinationLng: 37.0693,
    status: "parked", speed: 0, speedLimit: 80, engine: "off", fuelConsumption: 0, geofence: "inside", cargo: "Raw Sugar Cane", weight: 18,
  },
  {
    id: "KDE 234R", driver: "B. Omondi", lat: -0.4167, lng: 36.9500,
    location: "Nyeri Town, Central Kenya",
    departure: "Nyeri Farm Co-op",         departureLat: -0.4167, departureLng: 36.9500,
    destination: "Sukari Industries, Thika",    destinationLat: -1.0332, destinationLng: 37.0693,
    status: "ok", speed: 77, speedLimit: 80, engine: "on", fuelConsumption: 15.3, geofence: "inside", cargo: "Raw Sugar Cane", weight: 41,
  },
  {
    id: "KDD 890T", driver: "V. Njeri", lat: -1.0332, lng: 37.0693,
    location: "Thika Road, Kiambu County",
    departure: "Sukari Industries, Thika", departureLat: -1.0332, departureLng: 37.0693,
    destination: "Mombasa Port Depot",     destinationLat: -4.0435, destinationLng: 39.6682,
    status: "speeding", speed: 97, speedLimit: 80, engine: "on", fuelConsumption: 19.2, geofence: "outside", cargo: "Processed Sugar", weight: 39,
  },
  {
    id: "KDJ 789W", driver: "A. Maina", lat: 1.0154, lng: 35.0062,
    location: "Kitale, Trans-Nzoia County",
    departure: "Kitale Farm Store",        departureLat: 1.0154, departureLng: 35.0062,
    destination: "Eldoret Grain Store",    destinationLat: 0.5143, destinationLng: 35.2698,
    status: "ok", speed: 61, speedLimit: 80, engine: "on", fuelConsumption: 13.6, geofence: "inside", cargo: "Raw Sugar Cane", weight: 37,
  },
  {
    id: "KDH 901M", driver: "P. Wafula", lat: -1.5177, lng: 37.2634,
    location: "Machakos Town, Eastern Kenya",
    departure: "Machakos Farm Gate",       departureLat: -1.5177, departureLng: 37.2634,
    destination: "Sukari Industries, Thika",  destinationLat: -1.0332, destinationLng: 37.0693,
    status: "ok", speed: 53, speedLimit: 80, engine: "on", fuelConsumption: 12.1, geofence: "inside", cargo: "Raw Sugar Cane", weight: 34,
  },
  {
    id: "KCA 112X", driver: "A. Otieno", lat: -1.1000, lng: 37.1500,
    location: "Ruiru, Kiambu County",
    departure: "Sukari Industries, Thika",  departureLat: -1.0332, departureLng: 37.0693,
    destination: "Mombasa Port Depot",      destinationLat: -4.0435, destinationLng: 39.6682,
    status: "ok", speed: 68, speedLimit: 80, engine: "on", fuelConsumption: 13.8, geofence: "inside", cargo: "Processed Sugar", weight: 31,
  },
  {
    id: "KBZ 334Y", driver: "L. Kamau", lat: -0.7167, lng: 36.4333,
    location: "Gilgil, Nakuru County",
    departure: "Nakuru Depot #3",           departureLat: -0.3031, departureLng: 36.0800,
    destination: "Nairobi CBD Warehouse", destinationLat: -1.2921, destinationLng: 36.8219,
    status: "ok", speed: 55, speedLimit: 80, engine: "on", fuelConsumption: 12.5, geofence: "inside", cargo: "Processed Sugar", weight: 27,
  },
  {
    id: "KDD 567Z", driver: "M. Achieng", lat: -0.0900, lng: 34.9000,
    location: "Mumias, Kakamega County",
    departure: "Mumias Sugar Mill",         departureLat: -0.0900, departureLng: 34.9000,
    destination: "Kisumu Processing Plant", destinationLat: -0.1022, destinationLng: 34.7617,
    status: "ok", speed: 42, speedLimit: 80, engine: "on", fuelConsumption: 11.2, geofence: "inside", cargo: "Processed Sugar", weight: 29,
  },
  {
    id: "KDE 901A", driver: "S. Njuguna", lat: -1.2833, lng: 36.9833,
    location: "Juja, Kiambu County",
    departure: "Sukari Industries, Thika",       departureLat: -1.0332, departureLng: 37.0693,
    destination: "Nairobi CBD Warehouse",   destinationLat: -1.2921, destinationLng: 36.8219,
    status: "ok", speed: 61, speedLimit: 80, engine: "on", fuelConsumption: 13.0, geofence: "inside", cargo: "Processed Sugar", weight: 25,
  },
  {
    id: "KDF 230B", driver: "P. Kariuki", lat: -1.0500, lng: 37.3500,
    location: "Kangundo, Machakos County",
    departure: "Sukari Industries, Thika",        departureLat: -1.0332, departureLng: 37.0693,
    destination: "Nairobi CBD Warehouse",   destinationLat: -1.2921, destinationLng: 36.8219,
    status: "ok", speed: 74, speedLimit: 80, engine: "on", fuelConsumption: 14.5, geofence: "inside", cargo: "Processed Sugar", weight: 33,
  },
  {
    id: "KDC 445C", driver: "J. Okello", lat: -0.2000, lng: 34.8000,
    location: "Busia, Western Kenya",
    departure: "Kisumu Sugar Mill",         departureLat: -0.1022, departureLng: 34.7617,
    destination: "Nakuru Depot #3",         destinationLat: -0.3031, destinationLng: 36.0800,
    status: "ok", speed: 49, speedLimit: 80, engine: "on", fuelConsumption: 11.8, geofence: "outside", cargo: "Processed Sugar", weight: 30,
  },
  {
    id: "KDH 778D", driver: "F. Chebet", lat: 0.3833, lng: 35.1167,
    location: "Eldama Ravine, Baringo County",
    departure: "Sukari Industries, Thika",       departureLat: -1.0332, departureLng: 37.0693,
    destination: "Nakuru Depot #3",         destinationLat: -0.3031, destinationLng: 36.0800,
    status: "ok", speed: 58, speedLimit: 80, engine: "on", fuelConsumption: 12.9, geofence: "inside", cargo: "Processed Sugar", weight: 28,
  },
];

const SUKARI_VEHICLES = VEHICLES.map((v) => ({ ...v, companyId: "sukari" }));


const ALL_VEHICLES = [
  ...SUKARI_VEHICLES,
];

export default ALL_VEHICLES;
