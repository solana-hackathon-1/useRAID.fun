'use client';
import { useEffect, useRef } from 'react';

/**
 * A status message that takes focus when it appears or changes. After a save or an answer, the control that held
 * focus is disabled or removed, so focus would otherwise fall to the page body and the result would go unheard.
 */
export function FocusedStatus({ message }: { message: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (message) ref.current?.focus();
  }, [message]);
  return message ? (
    <p role="status" tabIndex={-1} ref={ref}>
      {message}
    </p>
  ) : null;
}
