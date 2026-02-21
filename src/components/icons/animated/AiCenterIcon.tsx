import type { FC } from "react";

export const AiCenterIcon: FC<{ className?: string }> = ({ className }) => (
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
        @keyframes ai-blink {
          0%, 3%, 100% { transform: scaleY(1); }
          1.5% { transform: scaleY(0.1); }
        }
        @keyframes ai-antenna {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
        .ai-eye-anim {
          transform-origin: 50% 14px;
          animation: ai-blink 4s infinite;
        }
        .ai-antenna-anim {
          animation: ai-antenna 1s infinite alternate;
        }
      `}
    </style>
    <path d="M12 8V4" />
    <circle cx="12" cy="4" r="1" className="ai-antenna-anim" />
    <path d="M8 8h8" />
    <rect width="16" height="12" x="4" y="8" rx="2" />
    <path d="M2 14h2" />
    <path d="M20 14h2" />
    <path d="M15 13v2" className="ai-eye-anim" strokeWidth="2.5" />
    <path d="M9 13v2" className="ai-eye-anim" strokeWidth="2.5" />
  </svg>
);
