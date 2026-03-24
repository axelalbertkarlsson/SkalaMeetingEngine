# Meetings Calendar V1

## Structure

- `src-tauri/src/calendar/*`
  Stores calendar source metadata and workspace-owned ICS files/cache under `.skala-meeting-engine/calendar`.
- `src-tauri/src/commands/calendar.rs`
  Exposes Tauri commands for listing sources, importing `.ics` files, adding subscriptions, removing sources, and loading raw source snapshots.
- `src/models/calendar.ts`
  Defines the normalized provider-agnostic calendar event and source model used by the UI.
- `src/services/calendar/ics.ts`
  Parses ICS data, normalizes fields, extracts practical recurrence info, and expands occurrences for rendering.
- `src/services/calendar/calendarService.ts`
  Provider dispatch layer. It takes raw source snapshots and asks the matching provider to return normalized events.
- `src/screens/MeetingsScreen.tsx`
  Meetings page orchestration: source actions, calendar state, view switching, and detail modal.
- `src/components/meetings/*`
  Pure rendering components for month, week/day time-grid, agenda, and meeting details.

## How Future Providers Plug In

The UI is intentionally built against normalized `CalendarEventOccurrence` objects, not ICS records.

To add Google Calendar or Microsoft Graph later:

1. Add a new source/storage adapter in the Tauri layer for auth/config/fetch.
2. Add a new provider implementation in `src/services/calendar/` that converts that provider's raw payload into the normalized calendar model.
3. Register that provider in `calendarService.ts`.

The calendar components should not need to change unless the product wants new UI behavior. The provider boundary is the place where source-specific fields stay source-specific.

## V1 Scope Notes

- ICS is the primary source for V1, via imported files and subscription URLs.
- Recurrence handling is practical rather than exhaustive: common `RRULE` patterns are expanded for month/week/day rendering.
- Timezone rendering is normalized before the UI sees the event data.
- Missing ICS fields are treated as optional and the UI falls back gracefully.
