<script lang="ts">
  interface Props {
    initials: string
    color: string
    size?: number
  }

  const { initials, color, size = 40 }: Props = $props()
</script>

<div
  class="avatar"
  style:width="{size}px"
  style:height="{size}px"
  style:background-color={color}
  style:font-size="{size * 0.4}px"
>
  {initials}
</div>

<style>
  .avatar {
    border-radius: var(--radius-full);
    display: flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    font-weight: var(--font-weight-semibold);
    flex-shrink: 0;
    user-select: none;
  }
</style>
