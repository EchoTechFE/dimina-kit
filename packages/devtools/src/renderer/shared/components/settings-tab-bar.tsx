import { Tabs, TabsList, TabsTrigger } from '@/shared/components/ui/tabs'

export interface SettingsTabBarProps<TabId extends string> {
  tabs: ReadonlyArray<{ id: TabId; label: string }>
  activeTab: TabId
  onTabChange: (tab: TabId) => void
}

/** Shared top-tab-bar shell for the settings/workbench-settings panels. */
export function SettingsTabBar<TabId extends string>({
  tabs,
  activeTab,
  onTabChange,
}: SettingsTabBarProps<TabId>) {
  return (
    <Tabs value={activeTab} onValueChange={(v) => onTabChange(v as TabId)} className="shrink-0 gap-0">
      <TabsList className="w-full">
        {tabs.map((tab) => (
          <TabsTrigger key={tab.id} value={tab.id} className="flex-1 justify-center">
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}
