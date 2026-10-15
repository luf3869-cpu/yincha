export function ForkMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <path
        d="M22 7v18.5c0 6.2 4.3 10 10 10s10-3.8 10-10V7"
        fill="none"
        stroke="currentColor"
        strokeWidth="3.2"
        strokeLinecap="round"
      />
      <path
        d="M32 35.5V55"
        fill="none"
        stroke="currentColor"
        strokeWidth="3.2"
        strokeLinecap="round"
      />
      <circle cx="32" cy="57.5" r="2.1" fill="currentColor" />
    </svg>
  );
}
