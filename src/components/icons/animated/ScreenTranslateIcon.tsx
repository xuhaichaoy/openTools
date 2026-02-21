import type { FC } from "react";

export const ScreenTranslateIcon: FC<{ className?: string }> = ({
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
        @keyframes translate-glow {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
        .translate-anim-1 { animation: translate-glow 2s ease-in-out infinite; }
        .translate-anim-2 { animation: translate-glow 2s ease-in-out infinite 1s; }
      `}
    </style>
    <g className="translate-anim-1">
      <path d="M2 5h12" />
      <path d="M7 2h1" />
      <path d="m5 8 6 6" />
      <path d="m4 14 6-6 2-3" />
    </g>
    <g className="translate-anim-2">
      <path d="m22 22-5-10-5 10" />
      <path d="M14 18h6" />
    </g>
  </svg>
);
