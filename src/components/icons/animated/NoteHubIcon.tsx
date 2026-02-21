import type { FC } from "react";

export const NoteHubIcon: FC<{ className?: string }> = ({ className }) => (
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
        @keyframes note-hub-write {
          0% { stroke-dasharray: 0 10; opacity: 0; }
          20%, 80% { stroke-dasharray: 10 10; opacity: 1; }
          100% { stroke-dasharray: 0 10; opacity: 0; }
        }
        .note-hub-anim-line1 { animation: note-hub-write 3s linear infinite; }
        .note-hub-anim-line2 { animation: note-hub-write 3s linear infinite 0.5s; }
        .note-hub-anim-line3 { animation: note-hub-write 3s linear infinite 1s; }
      `}
    </style>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    <path d="M10 9H8" className="note-hub-anim-line1" />
    <path d="M16 13H8" className="note-hub-anim-line2" />
    <path d="M16 17H8" className="note-hub-anim-line3" />
  </svg>
);
