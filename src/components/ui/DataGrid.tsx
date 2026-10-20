import { Fragment, useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, ArrowsOutLineHorizontal, CaretDown, DotsSixVertical, SlidersHorizontal } from '@phosphor-icons/react';

export type DataGridColumn<Row> = {
  id: string;
  label: string;
  width: number;
  minWidth?: number;
  required?: boolean;
  hidden?: boolean;
  align?: 'left' | 'right';
  render: (row: Row) => ReactNode;
};

export type DataGridSection<Row> = { id: string; label?: string; summary?: string; rows: Row[] };
type Preferences = { order: string[]; hidden: string[]; widths: Record<string, number> };

function defaults<Row>(columns: DataGridColumn<Row>[]): Preferences {
  return { order: columns.map((column) => column.id), hidden: columns.filter((column) => column.hidden && !column.required).map((column) => column.id), widths: {} };
}

function readPreferences<Row>(key: string, columns: DataGridColumn<Row>[]): Preferences {
  const initial = defaults(columns);
  try {
    const stored = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (!stored || !Array.isArray(stored.order) || !Array.isArray(stored.hidden)) return initial;
    const ids = new Set(initial.order);
    const order = [...new Set<string>(stored.order.filter((id: unknown): id is string => typeof id === 'string' && ids.has(id)))];
    return {
      order: [...order, ...initial.order.filter((id) => !order.includes(id))],
      hidden: columns.filter((column) => !column.required && stored.hidden.includes(column.id)).map((column) => column.id),
      widths: Object.fromEntries(columns.flatMap((column) => {
        const width = stored.widths?.[column.id];
        return typeof width === 'number' && Number.isFinite(width) ? [[column.id, Math.max(column.minWidth ?? 90, Math.min(900, width))]] : [];
      })),
    };
  } catch { return initial; }
}

export function DataGrid<Row>({ label, storageKey, columns, sections, getRowId, getRowLabel, getRowSelection, onToggleRows, renderExpandedRow, toolbar, emptyState, footer }: {
  label: string;
  storageKey: string;
  columns: DataGridColumn<Row>[];
  sections: DataGridSection<Row>[];
  getRowId: (row: Row) => string;
  getRowLabel: (row: Row) => string;
  getRowSelection: (row: Row) => 'all' | 'some' | 'none';
  onToggleRows: (rows: Row[]) => void;
  renderExpandedRow?: (row: Row) => ReactNode;
  toolbar?: ReactNode;
  emptyState: ReactNode;
  footer?: ReactNode;
}) {
  const [preferences, setPreferences] = useState(() => readPreferences(storageKey, columns));
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const resize = useRef<{ id: string; x: number; width: number } | null>(null);
  const settingsRef = useRef<HTMLDetailsElement>(null);
  const visibleColumns = preferences.order.flatMap((id) => {
    const column = columns.find((item) => item.id === id);
    return column && !preferences.hidden.includes(id) ? [column] : [];
  });
  const rows = sections.flatMap((section) => section.rows);
  const allSelected = rows.length > 0 && rows.every((row) => getRowSelection(row) === 'all');
  const someSelected = !allSelected && rows.some((row) => getRowSelection(row) !== 'none');
  const widthOf = (column: DataGridColumn<Row>) => preferences.widths[column.id] ?? column.width;

  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(preferences)); } catch { /* The grid still works when browser storage is unavailable. */ }
  }, [storageKey, preferences]);

  useEffect(() => {
    const closeSettings = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && !settingsRef.current?.contains(event.target)) settingsRef.current?.removeAttribute('open');
    };
    document.addEventListener('pointerdown', closeSettings);
    return () => document.removeEventListener('pointerdown', closeSettings);
  }, []);

  const moveColumn = (source: string, target: string) => {
    if (source === target) return;
    setPreferences((current) => {
      const order = [...current.order];
      const from = order.indexOf(source), to = order.indexOf(target);
      if (from < 0 || to < 0) return current;
      order.splice(to, 0, order.splice(from, 1)[0]!);
      return { ...current, order };
    });
  };

  const setWidth = (column: DataGridColumn<Row>, width: number) => {
    setPreferences((current) => ({ ...current, widths: { ...current.widths, [column.id]: Math.round(Math.max(column.minWidth ?? 90, Math.min(900, width))) } }));
  };

  const startResize = (event: PointerEvent<HTMLSpanElement>, column: DataGridColumn<Row>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    resize.current = { id: column.id, x: event.clientX, width: event.currentTarget.closest('th')!.getBoundingClientRect().width };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  return <section className="data-grid" aria-label={label}>
    <div className="data-grid-toolbar">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">{toolbar}</div>
      <details ref={settingsRef} className="data-grid-settings" onKeyDown={(event) => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); } }}>
        <summary className="erp-button-secondary inline-flex cursor-pointer list-none items-center gap-2"><SlidersHorizontal size={18} />Columnas<CaretDown size={12} /></summary>
        <div className="data-grid-settings-panel">
          <p className="mb-3 text-xs leading-relaxed text-[color:var(--muted)]">Mové las columnas con las flechas o arrastrá su encabezado. Ajustá el ancho desde el borde derecho.</p>
          {preferences.order.map((id, index) => {
            const column = columns.find((item) => item.id === id);
            if (!column) return null;
            return <div key={id} className="flex items-center gap-2 py-1">
              <label className="flex min-w-0 flex-1 items-center gap-2 py-2 text-sm"><input type="checkbox" checked={!preferences.hidden.includes(id)} disabled={column.required} onChange={() => setPreferences((current) => ({ ...current, hidden: current.hidden.includes(id) ? current.hidden.filter((item) => item !== id) : [...current.hidden, id] }))} />{column.label}</label>
              <button type="button" className="data-grid-icon-button" aria-label={`Mover ${column.label} a la izquierda`} disabled={index === 0} onClick={() => moveColumn(id, preferences.order[index - 1]!)}><ArrowLeft size={16} /></button>
              <button type="button" className="data-grid-icon-button" aria-label={`Mover ${column.label} a la derecha`} disabled={index === preferences.order.length - 1} onClick={() => moveColumn(id, preferences.order[index + 1]!)}><ArrowRight size={16} /></button>
            </div>;
          })}
          <button type="button" className="erp-toggle-link mt-3 text-sm" onClick={() => setPreferences(defaults(columns))}>Restablecer columnas y anchos</button>
        </div>
      </details>
    </div>
    <div className="data-grid-scroll" role="region" aria-label={`Desplazamiento de ${label.toLowerCase()}`} tabIndex={0}>
      <table className="data-grid-table" aria-label={label} style={{ minWidth: 48 + visibleColumns.reduce((sum, column) => sum + widthOf(column), 0) }}>
        <colgroup><col style={{ width: 48 }} />{visibleColumns.map((column) => <col key={column.id} style={{ width: widthOf(column) }} />)}</colgroup>
        <thead><tr>
          <th scope="col" className="data-grid-select"><input type="checkbox" aria-label="Seleccionar todos los visibles" disabled={!rows.length} checked={allSelected} ref={(node) => { if (node) node.indeterminate = someSelected; }} onChange={() => onToggleRows(rows)} /></th>
          {visibleColumns.map((column) => <th key={column.id} scope="col" aria-label={column.label} data-column={column.id} data-drop-target={dropTarget === column.id || undefined} className={column.align === 'right' ? 'text-right' : 'text-left'} onDragOver={(event) => { event.preventDefault(); if (draggedId !== column.id) setDropTarget(column.id); }} onDrop={(event) => { event.preventDefault(); if (draggedId) moveColumn(draggedId, column.id); setDraggedId(null); setDropTarget(null); }}>
            <span className="data-grid-heading" draggable onDragStart={(event) => { event.dataTransfer.setData('text/plain', column.id); event.dataTransfer.effectAllowed = 'move'; setDraggedId(column.id); }} onDragEnd={() => { setDraggedId(null); setDropTarget(null); }}>
              <DotsSixVertical size={14} aria-hidden="true" /><span>{column.label}</span>
            </span>
            <span role="separator" aria-label={`Ancho de ${column.label}`} aria-orientation="vertical" aria-valuemin={column.minWidth ?? 90} aria-valuemax={900} aria-valuenow={Math.round(widthOf(column))} tabIndex={0} className="data-grid-resize" title="Arrastrá para ajustar el ancho. Doble clic para restablecer." onPointerDown={(event) => startResize(event, column)} onPointerMove={(event) => { if (resize.current?.id === column.id) setWidth(column, resize.current.width + event.clientX - resize.current.x); }} onPointerUp={() => { resize.current = null; }} onPointerCancel={() => { resize.current = null; }} onLostPointerCapture={() => { resize.current = null; }} onDoubleClick={() => setWidth(column, column.width)} onKeyDown={(event) => { if (['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) { event.preventDefault(); setWidth(column, event.key === 'Home' ? column.width : widthOf(column) + (event.key === 'ArrowLeft' ? -20 : 20)); } }}><ArrowsOutLineHorizontal size={12} /></span>
          </th>)}
        </tr></thead>
        <tbody>
          {sections.map((section) => <Fragment key={section.id}>
            {section.label && <tr className="data-grid-group"><th colSpan={visibleColumns.length + 1} scope="rowgroup"><span>{section.label}</span>{section.summary && <span className="ml-3 font-normal text-[color:var(--muted)]">{section.summary}</span>}</th></tr>}
            {section.rows.map((row) => {
              const selection = getRowSelection(row);
              const expanded = renderExpandedRow?.(row);
              return <Fragment key={getRowId(row)}>
                <tr data-selected={selection === 'all' || undefined}>
                  <td className="data-grid-select"><input type="checkbox" aria-label={`Seleccionar ${getRowLabel(row)}`} checked={selection === 'all'} ref={(node) => { if (node) node.indeterminate = selection === 'some'; }} onChange={() => onToggleRows([row])} /></td>
                  {visibleColumns.map((column) => <td key={column.id} data-column={column.id} className={column.align === 'right' ? 'text-right' : undefined}>{column.render(row)}</td>)}
                </tr>
                {expanded && <tr className="data-grid-expanded"><td colSpan={visibleColumns.length + 1}>{expanded}</td></tr>}
              </Fragment>;
            })}
          </Fragment>)}
          {!rows.length && <tr><td colSpan={visibleColumns.length + 1} className="data-grid-empty">{emptyState}</td></tr>}
        </tbody>
      </table>
    </div>
    {footer && <div className="data-grid-footer" aria-live="polite">{footer}</div>}
  </section>;
}
