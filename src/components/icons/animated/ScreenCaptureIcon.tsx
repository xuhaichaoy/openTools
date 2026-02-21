import type { FC } from "react";

export const ScreenCaptureIcon: FC<{ className?: string }> = ({
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
        @keyframes capture-shutter {
          0%, 80%, 100% { r: 3; fill: none; }
          90% { r: 1; fill: currentColor; }
        }
        .capture-shutter-anim {
          transform-origin: 12px 13px;
          animation: capture-shutter 3s ease-in-out infinite;
        }
      `}
    </style>
    <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
    <circle cx="12" cy="13" r="3" className="capture-shutter-anim" />
  </svg>
);
