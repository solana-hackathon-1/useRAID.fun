import { readableScope } from '../work-http/scope-text';

const wrap = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } as const;
/** A scope as readable paragraphs and lists (React text only), or the plain sentence exactly as written. */
export function ScopeText({ scope }: { scope: string }) {
  const readable = readableScope(scope);
  if (!readable) return <p style={wrap}>{scope}</p>;
  return (
    <>
      {readable.outcome && <p style={wrap}>{readable.outcome}</p>}
      {readable.sections.map((section) => (
        <div key={section.label}>
          <p>
            <strong>{section.label}</strong>
          </p>
          <ul>
            {section.items.map((item, index) => (
              <li key={index} style={wrap}>
                {item}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}
