import type { FC } from "react";

export const ManagementCenterIcon: FC<{ className?: string }> = ({
  className,
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <style>
      {`
        @keyframes user-halo {
          0% { stroke-width: 2; opacity: 1; r: 4; }
          100% { stroke-width: 0.5; opacity: 0; r: 7; }
        }
        .user-anim-halo {
          transform-origin: center;
          animation: user-halo 2s cubic-bezier(0.165, 0.84, 0.44, 1) infinite;
        }
      `}
    </style>
    <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
    <circle
      cx="12"
      cy="7"
      r="4"
      className="user-anim-halo"
      stroke="currentColor"
      fill="none"
    />
  </svg>
);
