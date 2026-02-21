import type { FC } from "react";

export const WorkflowsIcon: FC<{ className?: string }> = ({ className }) => (
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
        @keyframes workflow-flow {
          0% { stroke-dashoffset: 24; }
          100% { stroke-dashoffset: 0; }
        }
        .workflow-flow-anim {
          stroke-dasharray: 4 4;
          animation: workflow-flow 1s linear infinite;
        }
      `}
    </style>
    <rect width="8" height="8" x="3" y="3" rx="2" />
    <path d="M7 11v4a2 2 0 0 0 2 2h4" className="workflow-flow-anim" />
    <rect width="8" height="8" x="13" y="13" rx="2" />
  </svg>
);
