import { fieldCompletenessLabel, type FieldCompleteness } from "@/lib/validation/field-completeness";

export function FieldCompletenessDetails({ completeness }: { completeness: FieldCompleteness }) {
  if (completeness.status === "complete") return <>Field complete</>;
  return (
    <div className="flex flex-col gap-space-2" data-testid="field-completeness-details">
      {([["Required", completeness.missing], ["Suggested", completeness.suggestions]] as const).map(([label, items]) => items.length > 0 && (
        <div key={label}>
          <p className="font-medium">{label}</p>
          <ul className="list-disc pl-space-4">
            {items.map((id) => <li key={id}>{fieldCompletenessLabel(id)}</li>)}
          </ul>
        </div>
      ))}
    </div>
  );
}
