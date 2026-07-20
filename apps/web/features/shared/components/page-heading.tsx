import type { ReactNode } from "react";

export function PageHeading({
  title,
  description,
  actions,
}: Readonly<{ title: ReactNode; description: string; actions?: ReactNode }>) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </div>
  );
}
