import type { ReactNode } from "react";
import "./Field.scss";

// A labeled form row. className passthrough covers variants like "input-with-hints".
export function Field({
  label,
  htmlFor,
  className,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className ? `field ${className}` : "field"}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
    </div>
  );
}
