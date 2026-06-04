export const CHANNELS = {
  SPAWN: 'dmb:spawn',
  DISPOSE: 'dmb:dispose',
  SERVICE_INVOKE: 'dmb:service:invoke',
  SERVICE_PUBLISH: 'dmb:service:publish',
  RENDER_INVOKE: 'dmb:render:invoke',
  RENDER_PUBLISH: 'dmb:render:publish',
  TO_SERVICE: 'dmb:to-service',
  TO_RENDER: 'dmb:to-render',
  SIMULATOR_API: 'dmb:simulator-api',
} as const

export type ChannelName = typeof CHANNELS[keyof typeof CHANNELS]
