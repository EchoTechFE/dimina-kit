import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ProjectList } from './project-list'

const mockProjects = [
  { name: 'Project A', path: '/path/a', lastOpened: null },
  { name: 'Project B', path: '/path/b', lastOpened: null },
]

describe('ProjectList', () => {
  it('renders empty state when no projects', () => {
    render(
      <ProjectList
        projects={[]}
        onAdd={() => {}}
        onOpen={() => {}}
        onRemove={() => {}}
      />
    )
    expect(screen.getByText('暂无项目，点击「导入」添加')).toBeInTheDocument()
  })

  it('renders project cards when projects exist', () => {
    render(
      <ProjectList
        projects={mockProjects}
        onAdd={() => {}}
        onOpen={() => {}}
        onRemove={() => {}}
      />
    )
    expect(screen.getByText('Project A')).toBeInTheDocument()
    expect(screen.getByText('Project B')).toBeInTheDocument()
  })

  it('filters projects by search', () => {
    render(
      <ProjectList
        projects={mockProjects}
        onAdd={() => {}}
        onOpen={() => {}}
        onRemove={() => {}}
      />
    )
    const input = screen.getByPlaceholderText('搜索')
    fireEvent.change(input, { target: { value: 'Project A' } })
    expect(screen.getByText('Project A')).toBeInTheDocument()
    expect(screen.queryByText('Project B')).not.toBeInTheDocument()
  })

  it('shows no match when search has no results', () => {
    render(
      <ProjectList
        projects={mockProjects}
        onAdd={() => {}}
        onOpen={() => {}}
        onRemove={() => {}}
      />
    )
    const input = screen.getByPlaceholderText('搜索')
    fireEvent.change(input, { target: { value: 'nonexistent' } })
    expect(screen.getByText('未找到匹配的项目')).toBeInTheDocument()
  })

  it('calls onOpen when project card is clicked', () => {
    const onOpen = vi.fn()
    render(
      <ProjectList
        projects={mockProjects}
        onAdd={() => {}}
        onOpen={onOpen}
        onRemove={() => {}}
      />
    )
    fireEvent.click(screen.getByText('Project A'))
    expect(onOpen).toHaveBeenCalledWith(mockProjects[0])
  })
})
