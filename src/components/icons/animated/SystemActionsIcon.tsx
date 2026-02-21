import type { FC } from "react";

export const SystemActionsIcon: FC<{ className?: string }> = ({
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
        @keyframes zap-shake {
          0%, 90%, 100% { transform: translateX(0); fill: none; }
          92%, 96% { transform: translateX(-1px); fill: currentColor; }
          94%, 98% { transform: translateX(1px); }
        }
        .zap-anim {
          animation: zap-shake 2s ease-in-out infinite;
        }
      `}
    </style>
    <polygon
      points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"
      className="zap-anim"
    />
  </svg>
);
