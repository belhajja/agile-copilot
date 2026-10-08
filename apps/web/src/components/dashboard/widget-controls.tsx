import { X } from 'lucide-react';
import type { UpdateWidgetActionResult } from '@/app/(app)/boards/[boardId]/actions';
import { Button } from '@/components/ui/button';
import { CardAction } from '@/components/ui/card';
import { EditWidget, type WidgetChanges } from './edit-widget';
import type { RenderedWidget } from './types';

/** What an editable dashboard (the "Pinned" one) passes down to its widgets. */
export interface WidgetEditing {
  /** Server action bound to the dashboard: removes one widget by id. */
  remove: (widgetId: string) => Promise<void>;
  removeLabel: string;
  /** Server action bound to the dashboard: renames a widget or changes its chart. */
  update: (widgetId: string, changes: WidgetChanges) => Promise<UpdateWidgetActionResult>;
}

/** Edit and remove buttons in a widget's card header. */
export function WidgetControls({
  editing,
  widget,
  defaultTitle,
}: {
  editing: WidgetEditing;
  widget: RenderedWidget;
  defaultTitle: string;
}) {
  const { spec } = widget;
  return (
    <CardAction className="flex">
      <EditWidget
        update={editing.update}
        widgetId={spec.id}
        title={spec.title}
        defaultTitle={defaultTitle}
        chart={spec.chart}
        charts={widget.charts ?? [spec.chart]}
      />
      <form action={editing.remove.bind(null, spec.id)}>
        <Button
          variant="ghost"
          size="icon"
          aria-label={editing.removeLabel}
          title={editing.removeLabel}
        >
          <X />
        </Button>
      </form>
    </CardAction>
  );
}
