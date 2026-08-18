// 每个用例只测一件事：点 label 时，tap / change / focus 分别落在谁身上、各几次。
// 操作前先点「清零」，操作后读计数表；日志按发生顺序追加。
Page({
	data: {
		rows: [],
		log: [],
		switchA: false,
		switchB: false,
		switchC: false,
		switchE: false,
		switchF: false,
		switchI: false,
		switchJ: false,
		switchInnerR: false,
		switchRemoteR: false,
		switchS: false,
		switchHiddenT: false,
		switchOuterU: false,
		switchInnerU: false,
		switchV: false,
		switchW: false,
		pickerY: [0],
		switchZ: false,
	},

	bump(key) {
		const rows = this.data.rows.slice()
		const index = rows.findIndex(row => row.key === key)
		if (index === -1) rows.push({ key, n: 1 })
		else rows[index] = { key, n: rows[index].n + 1 }

		const log = this.data.log.slice()
		log.push(`${log.length + 1}. ${key}`)
		this.setData({ rows, log })
	},

	hitName(e) {
		return e.currentTarget.dataset.name
	},

	onTap(e) {
		this.bump(`${this.hitName(e)}.tap`)
	},

	onChange(e) {
		const key = this.hitName(e)
		this.bump(`${key}.change=${e.detail.value}`)
		// 开关类控件的 data-name 与它的受控字段同名；分组控件（radio-group / checkbox-group）
		// 没有对应字段，跳过即可。
		if (key in this.data) this.setData({ [key]: e.detail.value })
	},

	onFocus(e) {
		this.bump(`${this.hitName(e)}.focus`)
	},

	// 激活补发的那次 tap 带不带触摸点和坐标，决定我们补发时该不该把 label 那次触摸的
	// touches / detail 原样传下去；把它们直接写进计数键，一眼看出是哪种。
	onTapPayload(e) {
		const d = e.detail || {}
		const touches = e.touches ? e.touches.length : 'nil'
		const changed = e.changedTouches ? e.changedTouches.length : 'nil'
		this.bump(`${this.hitName(e)}.tap x=${d.x} y=${d.y} t=${touches} ct=${changed}`)
	},

	// 一个处理器接所有原始事件，用事件类型本身当计数键，
	// 这样"什么都没发生"和"发生了但不是预期的那个"能区分开
	onRaw(e) {
		this.bump(`${this.hitName(e)}.${e.type}`)
	},

	reset() {
		this.setData({
			rows: [],
			log: [],
			switchA: false,
			switchB: false,
			switchC: false,
			switchE: false,
			switchF: false,
			switchI: false,
			switchJ: false,
			switchInnerR: false,
			switchRemoteR: false,
			switchS: false,
			switchHiddenT: false,
			switchOuterU: false,
			switchInnerU: false,
			switchV: false,
			switchW: false,
			pickerY: [0],
			switchZ: false,
		})
	},
})
