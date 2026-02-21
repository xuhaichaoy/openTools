import type { FC } from "react";

export const OcrIcon: FC<{ className?: string }> = ({ className }) => (
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
        @keyframes ocr-scanline {
          0%, 100% { transform: translateY(0); opacity: 0; }
          10%, 90% { opacity: 1; }
          50% { transform: translateY(12px); }
        }
        .ocr-scanline-anim {
          animation: ocr-scanline 2s ease-in-out infinite;
        }
      `}
    </style>
    <path d="M3 7V5a2 2 0 0 1 2-2h2" />
    <path d="M17 3h2a2 2 0 0 1 2 2v2" />
    <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
    <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
    <path d="M7 8h8" />
    <path d="M7 12h10" />
    <path d="M7 16h6" />
    <line
      x1="4"
      y1="6"
      x2="20"
      y2="6"
      stroke="currentColor"
      className="ocr-scanline-anim"
      strokeWidth="1"
      strokeDasharray="2 2"
    />
  </svg>
);
