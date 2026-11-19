export function DraftProjectName({ value }: { value: string }) {
  return (
    <span
      aria-label={value}
      className="min-w-0 line-clamp-2 whitespace-normal [overflow-wrap:anywhere]"
    >
      {value}
    </span>
  );
}
