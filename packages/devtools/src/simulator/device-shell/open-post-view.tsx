import { useState } from 'react'
import type { OpenPostDialogState } from '../ui-overlay-bus'
import './open-post-view.css'

const MAX_TITLE = 50
const MAX_CONTENT = 3000

/**
 * Full-page publish overlay matching HarmonyOS LitePublishPostPage. Covers the
 * entire device frame with a nav bar (back + island chip + publish), image
 * placeholder, title input (50 chars), content textarea (3000 chars), and a
 * bottom toolbar with character count + privacy toggle.
 */
export function OpenPostView({ dialog }: { dialog: OpenPostDialogState }) {
	const [title, setTitle] = useState('')
	const [content, setContent] = useState('')
	const [isPublic, setIsPublic] = useState(true)
	const canPublish = content.trim().length > 0

	return (
		<div className="dmui-publish">
			<div className="dmui-publish__nav">
				<button type="button" className="dmui-publish__back" onClick={() => dialog.onResult(false)}>
					<svg viewBox="0 0 24 24" width="20" height="20">
						<path
							d="M15 19l-7-7 7-7"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</svg>
				</button>
				<div className="dmui-publish__island-chip">
					{dialog.islandImage ? (
						<img className="dmui-publish__chip-avatar" src={dialog.islandImage} alt="" />
					) : (
						<div className="dmui-publish__chip-avatar dmui-publish__chip-avatar--placeholder" />
					)}
					<span className="dmui-publish__chip-name">{dialog.islandName || '未命名岛'}</span>
					<span className="dmui-publish__chip-tag">岛</span>
				</div>
				<button
					type="button"
					className={`dmui-publish__submit${canPublish ? '' : ' dmui-publish__submit--disabled'}`}
					disabled={!canPublish}
					onClick={() => dialog.onResult(true)}
				>
					发布
				</button>
			</div>
			<div className="dmui-publish__body">
				<div className="dmui-publish__images">
					<div className="dmui-publish__image-add">
						<svg viewBox="0 0 24 24" width="24" height="24">
							<path d="M12 5v14M5 12h14" fill="none" stroke="#999" strokeWidth="2" strokeLinecap="round" />
						</svg>
					</div>
				</div>
				<input
					className="dmui-publish__title"
					placeholder="标题 (50字以内)"
					value={title}
					maxLength={MAX_TITLE}
					onChange={(e) => setTitle(e.target.value)}
				/>
				<textarea
					className="dmui-publish__content"
					placeholder="写下你的想法..."
					value={content}
					maxLength={MAX_CONTENT}
					onChange={(e) => setContent(e.target.value)}
				/>
			</div>
			<div className="dmui-publish__toolbar">
				<span className="dmui-publish__count">
					{content.length}/{MAX_CONTENT}
				</span>
				<button type="button" className="dmui-publish__privacy" onClick={() => setIsPublic(!isPublic)}>
					{isPublic ? '公开' : '私密'}
				</button>
			</div>
		</div>
	)
}
