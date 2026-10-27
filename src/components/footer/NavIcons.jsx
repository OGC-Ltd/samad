// Icon set for the footer nav.



export const FleetIcon = ({ size = 22, active = false }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth={active ? 2.3 : 1.9} strokeLinecap="round" strokeLinejoin="round">
    <rect x="1" y="7" width="14" height="10" rx="1" />
    <path d="M15 10h4l3 4v3h-7v-7z" />
    <circle cx="5.5" cy="18.5" r="2" />
    <circle cx="17.5" cy="18.5" r="2" />
  </svg>
);

export const DriversIcon = ({ size = 22, active = false }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth={active ? 2.3 : 1.9} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="8" r="4" />
    <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
  </svg>
);

export const MaintenanceIcon = ({ size = 22, active = false }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth={active ? 2.3 : 1.9} strokeLinecap="round" strokeLinejoin="round">
    <path d="M14.7 6.3a4 4 0 0 1-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 1 5.4-5.4l-2.7 2.7-2-2 2.7-2.7z" />
  </svg>
);

export const WeighbridgeIcon = ({ size = 22, active = false }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth={active ? 2.3 : 1.9} strokeLinecap="round" strokeLinejoin="round">
    {/* platform scale: truck deck on a weighbridge plate */}
    <rect x="3" y="14" width="18" height="4" rx="1" />
    <path d="M6 14v-3h8v3" />
    <path d="M14 12h3l2 2" />
    <line x1="7" y1="21" x2="17" y2="21" />
    <line x1="12" y1="18" x2="12" y2="21" />
  </svg>
);

export const AnalyticsIcon = ({ size = 22, active = false }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth={active ? 2.3 : 1.9} strokeLinecap="round" strokeLinejoin="round">
    <line x1="5" y1="20" x2="5" y2="12" />
    <line x1="12" y1="20" x2="12" y2="6" />
    <line x1="19" y1="20" x2="19" y2="15" />
  </svg>
);
