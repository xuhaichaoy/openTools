import type { FC } from "react";

export const SnippetsIcon: FC<{ className?: string }> = ({ className }) => (
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
        @keyframes text-cursor-blink {
          0%, 50% { opacity: 1; }
          51%, 100% { opacity: 0; }
        }
        .cursor-anim {
          animation: text-cursor-blink 1s step-end infinite;
        }
      `}
    </style>
    <path d="M5 4h1a3 3 0 0 1 3 3 3 3 0 0 1 3-3h1" />
    <path d="M13 20h-1a3 3 0 0 1-3-3 3 3 0 0 1-3 3H5" />
    <path d="M5 16H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h1" />
    <path d="M13 8h7a2 2 0 0 1 2 2v4a2 2 0 0 1-2-2h-7" />
    <path d="M9 7v10" className="cursor-anim" strokeWidth="2.5" />
  </svg>
);
