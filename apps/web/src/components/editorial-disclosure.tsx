import { useId, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

export function EditorialDisclosure({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false),
    [keyboard, setKeyboard] = useState(false);
  const id = useId();
  return (
    <section
      className="panel editorial-settings t-acc"
      data-open={String(open)}
      data-keyboard={String(keyboard)}
    >
      <button
        type="button"
        className="t-acc-head"
        aria-expanded={open}
        aria-controls={id}
        onClick={(event) => {
          setKeyboard(event.detail === 0);
          setOpen(!open);
        }}
      >
        {title}
        <span className="t-acc-chevron" aria-hidden="true">
          <ChevronDown size={18} />
        </span>
      </button>
      <div className="t-acc-panel" id={id} inert={!open} aria-hidden={!open}>
        <div className="t-acc-panel-inner">
          <div className="editorial-disclosure-content">{children}</div>
        </div>
      </div>
    </section>
  );
}
