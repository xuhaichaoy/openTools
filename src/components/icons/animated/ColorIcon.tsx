import type { FC } from "react";

export const ColorIcon: FC<{ className?: string }> = ({ className }) => (
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
        @keyframes pipette-drop {
          0% { transform: translateY(0) scale(0); opacity: 0; }
          20% { transform: translateY(2px) scale(1); opacity: 1; }
          80% { transform: translateY(8px) scale(1); opacity: 1; }
          100% { transform: translateY(12px) scale(0); opacity: 0; }
        }
        .color-drop-anim {
          animation: pipette-drop 2s infinite;
          transform-origin: 3.5px 20.5px;
        }
      `}
    </style>
    <path d="m2 22 1-1h3l9-9" />
    <path d="M3 21v-3l9-9" />
    <path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z" />
    <circle
      cx="3.5"
      cy="20.5"
      r="1.5"
      className="color-drop-anim"
      fill="currentColor"
      stroke="none"
    />
  </svg>
);
