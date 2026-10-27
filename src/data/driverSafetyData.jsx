// Mock driver safety score profiles.



const DRIVER_SAFETY_AXES = ["Speed", "Braking", "Idling", "Fuel Use", "Compliance"];

const DRIVER_SAFETY_BY_COMPANY = {
  sukari: [
    { driver: "A. Maina", scores: { "Speed": 83, "Braking": 67, "Idling": 60, "Fuel Use": 66, "Compliance": 65 } },
    { driver: "R. Koech", scores: { "Speed": 92, "Braking": 72, "Idling": 66, "Fuel Use": 67, "Compliance": 60 } },
    { driver: "C. Wambu", scores: { "Speed": 61, "Braking": 66, "Idling": 72, "Fuel Use": 92, "Compliance": 86 } },
  ],
};

export { DRIVER_SAFETY_AXES };
export default DRIVER_SAFETY_BY_COMPANY;
