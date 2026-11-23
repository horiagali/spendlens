import type { Category } from '../api.ts';

export function CategorySelect({ categories, value, onChange, income, placeholder = 'Pick category…' }: {
  categories: Category[]; value: number | null; onChange: (id: number | null) => void; income?: boolean; placeholder?: string;
}) {
  const groups = [
    { label: 'Spending', items: categories.filter((c) => !c.isIncome) },
    { label: 'Income', items: categories.filter((c) => c.isIncome) },
  ];
  if (income) groups.reverse();
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      <option value="">{placeholder}</option>
      {groups.map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </optgroup>
      ))}
    </select>
  );
}
