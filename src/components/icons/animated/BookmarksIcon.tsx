import type { FC } from "react";

export const BookmarksIcon: FC<{ className?: string }> = ({ className }) => (
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
        @keyframes mark-bounce {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-2px); }
        }
        .bookmark-anim {
          transform-origin: top;
          animation: mark-bounce 2s ease-in-out infinite;
        }
      `}
    </style>
    <path
      className="bookmark-anim"
      d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"
    />
  </svg>
);
