<script setup>
import { triggerEvent, useInfo } from '@/common/events'

// 滑动选择器
// https://developers.weixin.qq.com/miniprogram/dev/component/slider.html

const props = defineProps({
	/**
	 * id，为 label 使用
	 */
	id: {
		type: String,
	},
	/**
	 * name，为表单使用
	 */
	name: {
		type: String,
	},
	/**
	 * 最小值
	 */
	min: {
		type: Number,
		default: 0,
		required: false,
	},
	/**
	 * 最大值
	 */
	max: {
		type: Number,
		default: 100,
		required: false,
	},
	/**
	 * 步长，取值必须大于 0，并且可被(max - min)整除
	 */
	step: {
		type: Number,
		default: 1,
		required: false,
	},
	/**
	 * 是否禁用
	 */
	disabled: {
		type: Boolean,
		default: false,
		required: false,
	},
	/**
	 * 当前取值
	 */
	value: {
		type: Number,
		default: 0,
		required: false,
	},
	/**
	 * 背景条的颜色（请使用 backgroundColor）
	 */
	color: {
		type: String,
		default: '#e9e9e9',
		required: false,
	},
	/**
	 * 已选择的颜色（请使用 activeColor）
	 */
	selectedColor: {
		type: String,
		default: '#1aad19',
		required: false,
	},
	/**
	 * 进度条激活态颜色
	 */
	activeColor: {
		type: String,
		default: '#1aad19',
		required: false,
	},
	/**
	 * 进度条非激活态颜色
	 */
	backgroundColor: {
		type: String,
		default: '#e9e9e9',
		required: false,
	},
	/**
	 * 滑块的大小，取值范围为 12 - 28
	 */
	blockSize: {
		type: Number,
		default: 28,
		required: false,
		validator: value => value >= 12 && value <= 28,
	},
	/**
	 * 滑块的颜色
	 */
	blockColor: {
		type: String,
		default: '#ffffff',
		required: false,
	},
	/**
	 * 是否显示当前 value
	 */
	showValue: {
		type: Boolean,
		default: false,
		required: false,
	},
})

const valColor = computed(() => {
	return props.activeColor || props.selectedColor
})

const backColor = computed(() => {
	return {
		backgroundColor: props.backgroundColor || props.color,
	}
})

// blockSize / blockColor 只有落到内联样式上才生效：样式表里
// .dd-slider-handle / .dd-slider-thumb 的尺寸和底色都是写死的。
const blockStyle = computed(() => ({
	backgroundColor: props.blockColor,
	height: `${props.blockSize}px`,
	marginLeft: `${-props.blockSize / 2}px`,
	marginTop: `${-props.blockSize / 2}px`,
	width: `${props.blockSize}px`,
}))

function roundToStep(value) {
	const min = Number(props.min)
	const max = Number(props.max)
	const step = Number(props.step)

	// Clamps a number between a minimum and maximum value.
	const clamp = Math.min(Math.max(value, min), max)
	// Rounds a number to the nearest multiple of a given step size.
	return Math.round(clamp / step) * step
}

const sliderHandle = ref(null)
// 组件根元素。逻辑层通过 event.currentTarget 上的 data-sid 反查节点，
// 而 data-sid 只挂在根元素上（由 $attrs 绑入）。
const sliderRoot = ref(null)

// 格式化显示值
const disValue = ref(roundToStep(Number(props.value)))

// 注入父组件提供的方法
const collectFormValue = inject('collectFormValue', undefined)
collectFormValue?.(props.name, disValue.value)

const range = computed(() => Number(props.max) - Number(props.min))

// 计算百分比
const percent = computed(() => {
	return ((disValue.value - Number(props.min)) / range.value) * 100
})

let isDragging = false

function startDrag() {
	if (props.disabled) {
		return
	}
	isDragging = true
}

const info = useInfo()

/**
 * 把根元素充当事件的 currentTarget 后再交给 triggerEvent。
 *
 * 交互事件的原生 currentTarget 不是根元素：点击落在内部的 .dd-slider-tap-area 上，
 * 拖动过程中的 touchmove / touchend 挂在 window 上。两者都不带 data-sid，逻辑层
 * 反查不到节点就会静默丢弃事件，表现为 slider 能拖动但绑定的 bindchange /
 * bindchanging 从不触发。
 *
 * 位置计算仍使用原始事件，这里只用于事件上报。
 */
function bridgeEvent(event) {
	return {
		currentTarget: sliderRoot.value,
		target: event?.target ?? sliderRoot.value,
		pageX: event?.pageX,
		pageY: event?.pageY,
		touches: event?.touches,
		changedTouches: event?.changedTouches,
		cancelable: event?.cancelable,
		preventDefault: () => event?.preventDefault?.(),
		stopPropagation: () => event?.stopPropagation?.(),
	}
}

function drag(event) {
	if (!isDragging || Boolean(props.disabled)) {
		return
	}
	if (event.cancelable) {
		event.preventDefault()
	}
	updateValue(event)
}

function updateValue(event, eventType = 'changing') {
	const clientX = event.touches ? event.touches[0].clientX : event.clientX
	const rect = sliderHandle.value?.getBoundingClientRect()
	if (!rect?.width) {
		return
	}
	const delta = clientX - rect.left
	const position = (delta / rect.width) * range.value + Number(props.min)
	const disV = roundToStep(position)
	disValue.value = disV

	collectFormValue?.(props.name, disV)

	// 拖动过程中触发的事件
	triggerEvent(eventType, {
		event: bridgeEvent(event),
		info,
		detail: {
			value: disV,
		},
	})
}

function endDrag(event) {
	if (!isDragging || Boolean(props.disabled)) {
		return
	}

	isDragging = false

	// 完成一次拖动后触发的事件
	triggerEvent('change', {
		event: bridgeEvent(event),
		info,
		detail: {
			value: disValue.value,
		},
	})
}

function handleClick(event) {
	if (isDragging) {
		isDragging = false
		return
	}

	if (props.disabled) {
		return
	}
	updateValue(event, 'change')
}

onMounted(() => {
	window.addEventListener('mousemove', drag)
	window.addEventListener('mouseup', endDrag)
	window.addEventListener('touchmove', drag, { passive: false })
	window.addEventListener('touchend', endDrag)
	window.addEventListener('touchcancel', endDrag)
})

onBeforeUnmount(() => {
	window.removeEventListener('mousemove', drag)
	window.removeEventListener('mouseup', endDrag)
	window.removeEventListener('touchmove', drag)
	window.removeEventListener('touchend', endDrag)
	window.removeEventListener('touchcancel', endDrag)
})
</script>

<template>
	<div :id="id" ref="sliderRoot" v-bind="$attrs" class="dd-slider">
		<div class="dd-slider-wrapper">
			<div ref="sliderHandle" class="dd-slider-tap-area" @click="handleClick">
				<div class="dd-slider-handle-wrapper" :style="backColor">
					<div
						class="dd-slider-handle"
						:style="{ ...blockStyle, left: `${percent}%`, backgroundColor: 'transparent' }"
						@touchstart="startDrag" @mousedown="startDrag"
					/>
					<div class="dd-slider-thumb" :style="{ ...blockStyle, left: `${percent}%` }" />
					<div class="dd-slider-track" :style="{ width: `${percent}%`, backgroundColor: valColor }" />
					<div class="dd-slider-step" />
				</div>
			</div>
			<span class="dd-slider-value" :hidden="!showValue">
				<p parse-text-content style="width: 3ch">{{ disValue }}</p>
			</span>
		</div>
	</div>
</template>

<style lang="scss">
.dd-slider {
	margin: 10px 18px;
	padding: 0;
	display: block;

	&[hidden] {
		display: block;
	}
}

.dd-slider-wrapper {
	display: flex;
	align-items: center;
	min-height: 16px;
}

.dd-slider-tap-area {
	flex: 1;
	padding: 8px 0;
}

.dd-slider-handle-wrapper {
	position: relative;
	z-index: 0;
	height: 2px;
	border-radius: 5px;
	background-color: #e9e9e9;
	cursor: pointer;
	transition: background-color 0.3s ease;
	-webkit-tap-highlight-color: transparent;
}
.dd-slider-track {
	height: 100%;
	border-radius: 6px;
	background-color: #1aad19;
	transition: background-color 0.3s ease;
}
.dd-slider-handle,
.dd-slider-thumb {
	position: absolute;
	left: 0%;
	top: 50%;
	cursor: grab;
	border-radius: 50%;
	transition: border-color 0.3s ease;
}
.dd-slider-handle {
	width: 28px;
	height: 28px;
	margin-top: -14px;
	margin-left: -14px;
	background-color: transparent;
	z-index: 3;
}
.dd-slider-thumb {
	z-index: 2;
	box-shadow: 0 0 4px rgba(0, 0, 0, 0.2);
	width: 28px;
	height: 28px;
	margin-left: -14px;
	margin-top: -14px;
	background-color: rgb(255, 255, 255);
}
.dd-slider-step {
	position: absolute;
	width: 100%;
	height: 2px;
	background: transparent;
	z-index: 1;
}
.dd-slider-value {
	color: #888;
	font-size: 14px;
	margin-left: 1em;
	text-align: center;
}
.dd-slider-disabled .dd-slider-track {
	background-color: #ccc;
}
.dd-slider-disabled .dd-slider-thumb {
	background-color: #fff;
	border-color: #ccc;
}
</style>
