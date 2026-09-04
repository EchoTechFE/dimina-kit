import { useEffect, useMemo, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/shared/components/ui/command'
import { cn } from '@/shared/lib/utils'
import type { DeviceFormFactor, DeviceOS, DeviceProfile } from '@devicekit/devices'

// Groups mirror DEVICES' own os ordering (iOS → Android → HarmonyOS); a
// group is only rendered once it has at least one matching device, so an os
// chip filter doesn't leave two empty headings behind.
const OS_GROUPS: Array<{ os: DeviceOS; label: string }> = [
  { os: 'ios', label: 'iOS' },
  { os: 'android', label: 'Android' },
  { os: 'harmony', label: 'HarmonyOS' },
]

const OS_CHIPS: Array<{ os: DeviceOS | null; label: string }> = [
  { os: null, label: '全部' },
  ...OS_GROUPS,
]

const FORM_FACTOR_CHIPS: Array<{ formFactor: DeviceFormFactor; label: string }> = [
  { formFactor: 'phone', label: '手机' },
  { formFactor: 'tablet', label: '平板' },
]

/**
 * Search haystack for cmdk's built-in fuzzy filter, one string per device so
 * "14 pro", "android 14", and "390" all resolve to the same matches. The size
 * is indexed both as typed on a keyboard ("393x852") and as the row displays
 * it ("393×852"), since cmdk's filter does not fold the two characters.
 */
export function buildSearchValue(d: DeviceProfile): string {
  const { width, height } = d.screen
  return [d.name, d.system ?? '', `${width}x${height}`, `${width}×${height}`].join(' ')
}

interface DevicePickerProps {
  device: DeviceProfile
  devices: readonly DeviceProfile[]
  onSelect: (name: string) => void
}

/**
 * Toolbar trigger button + searchable panel over the full device table.
 * Chip filters (os / form factor) narrow the candidate list in React;
 * free-text search is left to cmdk's own fuzzy match against
 * `buildSearchValue`, so the two filters stack without either duplicating
 * the other's logic.
 */
export function DevicePicker({ device, devices, onSelect }: DevicePickerProps) {
  const [open, setOpen] = useState(false)
  const [osFilter, setOsFilter] = useState<DeviceOS | null>(null)
  const [formFactorFilter, setFormFactorFilter] = useState<DeviceFormFactor | null>(null)
  const currentRowRef = useRef<HTMLDivElement>(null)

  // cmdk mounts the list synchronously with the dialog (no lazy content), so
  // the current row's ref is already attached once `open` flips true.
  useEffect(() => {
    if (!open) return
    const el = currentRowRef.current
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'center' })
    }
  }, [open])

  const filtered = useMemo(
    () =>
      devices.filter(
        (d) =>
          (!osFilter || d.os === osFilter) &&
          (!formFactorFilter || (d.formFactor ?? 'phone') === formFactorFilter),
      ),
    [devices, osFilter, formFactorFilter],
  )

  const groups = useMemo(
    () =>
      OS_GROUPS.map((g) => ({ ...g, devices: filtered.filter((d) => d.os === g.os) })).filter(
        (g) => g.devices.length > 0,
      ),
    [filtered],
  )

  function handleSelect(name: string) {
    onSelect(name)
    setOpen(false)
  }

  return (
    <>
      {/* Pre-highlight the current device so Enter on a fresh open keeps it
          instead of jumping to the first row of the list. */}
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="选择机型"
        trigger={
          <Button
            variant="outline"
            size="sm"
            className="h-7 justify-start px-2 text-[13px] font-medium text-text-secondary"
          >
            {device.name}
          </Button>
        }
        commandProps={{ defaultValue: buildSearchValue(device) }}
      >
        <CommandInput placeholder="搜索机型：名称 / 系统 / 尺寸" autoFocus />
        <div className="flex flex-wrap items-center gap-1 border-b border-border-subtle px-3 py-2">
          {OS_CHIPS.map((chip) => (
            <Chip
              key={chip.label}
              label={chip.label}
              active={osFilter === chip.os}
              onClick={() => setOsFilter(chip.os)}
            />
          ))}
          <span className="mx-1 h-4 w-px bg-border-subtle" />
          {FORM_FACTOR_CHIPS.map((chip) => (
            <Chip
              key={chip.label}
              label={chip.label}
              active={formFactorFilter === chip.formFactor}
              onClick={() =>
                setFormFactorFilter((cur) => (cur === chip.formFactor ? null : chip.formFactor))
              }
            />
          ))}
        </div>
        <CommandList>
          <CommandEmpty>没有匹配的机型</CommandEmpty>
          {groups.map((g) => (
            <CommandGroup key={g.os} heading={g.label}>
              {g.devices.map((d) => {
                const isCurrent = d.name === device.name
                return (
                  <CommandItem
                    key={d.name}
                    ref={isCurrent ? currentRowRef : undefined}
                    value={buildSearchValue(d)}
                    aria-label={d.name}
                    data-current={isCurrent || undefined}
                    onSelect={() => handleSelect(d.name)}
                    className="flex items-center justify-between gap-2"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <Check
                        className={cn('size-3.5 shrink-0', isCurrent ? 'opacity-100' : 'opacity-0')}
                      />
                      <span className="truncate">{d.name}</span>
                      {d.formFactor === 'tablet' && (
                        <span className="shrink-0 rounded-[var(--qd-radius-sm)] bg-[var(--qd-muted)] px-1.5 py-0.5 text-[10px] text-text-secondary">
                          平板
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 text-xs text-text-secondary">
                      {d.screen.width}×{d.screen.height} @{d.pixelRatio}x
                      {d.system ? ` · ${d.system}` : ''}
                    </span>
                  </CommandItem>
                )
              })}
            </CommandGroup>
          ))}
        </CommandList>
      </CommandDialog>
    </>
  )
}

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <Button
      variant="toolbar"
      size="xs"
      aria-pressed={active}
      data-active={active ? 'true' : 'false'}
      onClick={onClick}
    >
      {label}
    </Button>
  )
}
