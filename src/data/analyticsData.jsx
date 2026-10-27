// Mock daily analytics trend data per company.



const ANALYTICS_TREND_BY_COMPANY = {
  sukari: [
    { date: "2026-06-02", label: "Jun 02", dayLabel: "Tue", deliveries: 29, distanceKm: 1762, fuelEfficiency: 11.1, onTimeRate: 85.2, utilizationRate: 81.3, incidents: 5, minorSpeeding: 3, majorSpeeding: 1 },
    { date: "2026-06-03", label: "Jun 03", dayLabel: "Wed", deliveries: 19, distanceKm: 810, fuelEfficiency: 9.4, onTimeRate: 87.1, utilizationRate: 76.4, incidents: 0, minorSpeeding: 0, majorSpeeding: 0 },
    { date: "2026-06-04", label: "Jun 04", dayLabel: "Thu", deliveries: 30, distanceKm: 1499, fuelEfficiency: 7.9, onTimeRate: 92.8, utilizationRate: 75.5, incidents: 6, minorSpeeding: 6, majorSpeeding: 0 },
    { date: "2026-06-05", label: "Jun 05", dayLabel: "Fri", deliveries: 28, distanceKm: 1460, fuelEfficiency: 10.2, onTimeRate: 92.7, utilizationRate: 94.9, incidents: 5, minorSpeeding: 2, majorSpeeding: 2 },
    { date: "2026-06-06", label: "Jun 06", dayLabel: "Sat", deliveries: 16, distanceKm: 716, fuelEfficiency: 11.4, onTimeRate: 92.0, utilizationRate: 89.3, incidents: 4, minorSpeeding: 1, majorSpeeding: 2 },
    { date: "2026-06-07", label: "Jun 07", dayLabel: "Sun", deliveries: 14, distanceKm: 682, fuelEfficiency: 10.2, onTimeRate: 86.5, utilizationRate: 66.4, incidents: 4, minorSpeeding: 2, majorSpeeding: 2 },
    { date: "2026-06-08", label: "Jun 08", dayLabel: "Mon", deliveries: 25, distanceKm: 999, fuelEfficiency: 9.4, onTimeRate: 92.0, utilizationRate: 93.8, incidents: 5, minorSpeeding: 2, majorSpeeding: 2 },
    { date: "2026-06-09", label: "Jun 09", dayLabel: "Tue", deliveries: 19, distanceKm: 1132, fuelEfficiency: 9.8, onTimeRate: 96.5, utilizationRate: 76.4, incidents: 2, minorSpeeding: 1, majorSpeeding: 1 },
    { date: "2026-06-10", label: "Jun 10", dayLabel: "Wed", deliveries: 19, distanceKm: 1079, fuelEfficiency: 10.4, onTimeRate: 95.6, utilizationRate: 68.6, incidents: 4, minorSpeeding: 4, majorSpeeding: 0 },
    { date: "2026-06-11", label: "Jun 11", dayLabel: "Thu", deliveries: 30, distanceKm: 1260, fuelEfficiency: 11.4, onTimeRate: 84.8, utilizationRate: 75.0, incidents: 0, minorSpeeding: 0, majorSpeeding: 0 },
    { date: "2026-06-12", label: "Jun 12", dayLabel: "Fri", deliveries: 26, distanceKm: 1596, fuelEfficiency: 10.8, onTimeRate: 97.3, utilizationRate: 79.4, incidents: 5, minorSpeeding: 3, majorSpeeding: 2 },
    { date: "2026-06-13", label: "Jun 13", dayLabel: "Sat", deliveries: 12, distanceKm: 737, fuelEfficiency: 9.2, onTimeRate: 86.7, utilizationRate: 62.7, incidents: 5, minorSpeeding: 3, majorSpeeding: 2 },
    { date: "2026-06-14", label: "Jun 14", dayLabel: "Sun", deliveries: 15, distanceKm: 735, fuelEfficiency: 8.9, onTimeRate: 85.3, utilizationRate: 80.0, incidents: 5, minorSpeeding: 5, majorSpeeding: 0 },
    { date: "2026-06-15", label: "Jun 15", dayLabel: "Mon", deliveries: 20, distanceKm: 962, fuelEfficiency: 11.1, onTimeRate: 90.2, utilizationRate: 72.3, incidents: 4, minorSpeeding: 3, majorSpeeding: 0 },
    { date: "2026-06-16", label: "Jun 16", dayLabel: "Tue", deliveries: 18, distanceKm: 1099, fuelEfficiency: 11.1, onTimeRate: 94.4, utilizationRate: 79.6, incidents: 5, minorSpeeding: 3, majorSpeeding: 1 },
    { date: "2026-06-17", label: "Jun 17", dayLabel: "Wed", deliveries: 27, distanceKm: 1387, fuelEfficiency: 9.8, onTimeRate: 95.6, utilizationRate: 63.9, incidents: 6, minorSpeeding: 5, majorSpeeding: 0 },
    { date: "2026-06-18", label: "Jun 18", dayLabel: "Thu", deliveries: 30, distanceKm: 1665, fuelEfficiency: 9.4, onTimeRate: 86.3, utilizationRate: 83.8, incidents: 4, minorSpeeding: 2, majorSpeeding: 2 },
    { date: "2026-06-19", label: "Jun 19", dayLabel: "Fri", deliveries: 20, distanceKm: 1029, fuelEfficiency: 9.5, onTimeRate: 90.3, utilizationRate: 85.9, incidents: 2, minorSpeeding: 0, majorSpeeding: 1 },
    { date: "2026-06-20", label: "Jun 20", dayLabel: "Sat", deliveries: 10, distanceKm: 610, fuelEfficiency: 10.6, onTimeRate: 89.6, utilizationRate: 88.6, incidents: 1, minorSpeeding: 0, majorSpeeding: 0 },
    { date: "2026-06-21", label: "Jun 21", dayLabel: "Sun", deliveries: 15, distanceKm: 914, fuelEfficiency: 9.4, onTimeRate: 87.9, utilizationRate: 81.5, incidents: 6, minorSpeeding: 4, majorSpeeding: 2 },
    { date: "2026-06-22", label: "Jun 22", dayLabel: "Mon", deliveries: 24, distanceKm: 1084, fuelEfficiency: 11.1, onTimeRate: 85.2, utilizationRate: 91.6, incidents: 8, minorSpeeding: 6, majorSpeeding: 1 },
    { date: "2026-06-23", label: "Jun 23", dayLabel: "Tue", deliveries: 27, distanceKm: 1462, fuelEfficiency: 10.0, onTimeRate: 88.1, utilizationRate: 71.5, incidents: 4, minorSpeeding: 2, majorSpeeding: 1 },
    { date: "2026-06-24", label: "Jun 24", dayLabel: "Wed", deliveries: 30, distanceKm: 1386, fuelEfficiency: 9.2, onTimeRate: 89.9, utilizationRate: 89.4, incidents: 6, minorSpeeding: 3, majorSpeeding: 2 },
    { date: "2026-06-25", label: "Jun 25", dayLabel: "Thu", deliveries: 24, distanceKm: 1310, fuelEfficiency: 9.2, onTimeRate: 96.5, utilizationRate: 95.6, incidents: 4, minorSpeeding: 1, majorSpeeding: 2 },
    { date: "2026-06-26", label: "Jun 26", dayLabel: "Fri", deliveries: 19, distanceKm: 933, fuelEfficiency: 8.2, onTimeRate: 91.9, utilizationRate: 75.9, incidents: 7, minorSpeeding: 6, majorSpeeding: 0 },
    { date: "2026-06-27", label: "Jun 27", dayLabel: "Sat", deliveries: 15, distanceKm: 610, fuelEfficiency: 10.6, onTimeRate: 91.9, utilizationRate: 76.9, incidents: 4, minorSpeeding: 3, majorSpeeding: 0 },
    { date: "2026-06-28", label: "Jun 28", dayLabel: "Sun", deliveries: 11, distanceKm: 567, fuelEfficiency: 10.1, onTimeRate: 94.9, utilizationRate: 66.5, incidents: 6, minorSpeeding: 4, majorSpeeding: 1 },
    { date: "2026-06-29", label: "Jun 29", dayLabel: "Mon", deliveries: 21, distanceKm: 837, fuelEfficiency: 11.2, onTimeRate: 93.2, utilizationRate: 66.1, incidents: 2, minorSpeeding: 0, majorSpeeding: 2 },
    { date: "2026-06-30", label: "Jun 30", dayLabel: "Tue", deliveries: 30, distanceKm: 1238, fuelEfficiency: 10.3, onTimeRate: 97.1, utilizationRate: 70.6, incidents: 6, minorSpeeding: 5, majorSpeeding: 1 },
    { date: "2026-07-01", label: "Jul 01", dayLabel: "Wed", deliveries: 28, distanceKm: 1469, fuelEfficiency: 10.0, onTimeRate: 88.6, utilizationRate: 64.8, incidents: 0, minorSpeeding: 0, majorSpeeding: 0 },
  ],
};

export default ANALYTICS_TREND_BY_COMPANY;
