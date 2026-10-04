import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CardAction } from '@/components/ui/card';

/** What a removable dashboard (the "Pinned" one) passes down to its widgets. */
export interface WidgetRemoval {
  /** Server action bound to the dashboard: removes one widget by id. */
  action: (widgetId: string) => Promise<void>;
  label: string;
}

/** A small "remove" button in a widget's card header. */
export function RemoveWidget({ removal, widgetId }: { removal: WidgetRemoval; widgetId: string }) {
  return (
    <CardAction>
      <form action={removal.action.bind(null, widgetId)}>
        <Button variant="ghost" size="icon" aria-label={removal.label} title={removal.label}>
          <X />
        </Button>
      </form>
    </CardAction>
  );
}
