# Spec: cross-platform-personalization

## Why
- 当前只有横图会把背景延伸到侧边栏，竖图和方图体验不一致。
- 当前只能手动换图，需要从本地图片文件夹定时轮换。

## Scope
- 本次要做：macOS 和 Windows 的所有图片宽高比都使用整窗背景并延伸到侧边栏。
- 本次要做：两端从现有图片目录定时换图，默认 1 分钟，允许配置间隔和启停。
- 本次要做：SwiftBar 和 Windows 托盘提供轮换控制与状态。
- 本次不做：随机/权重播放、子目录、联网图库、按主题包轮换。

## Plan
- [x] 调整 `macos/assets/dream-skin.css` 和 `windows/assets/dream-skin.css`，移除侧边栏沉浸效果的横图门槛。
- [x] 为两端增加图片目录轮换与持久化间隔配置，复用现有图片校验和热应用链路。
- [x] 扩展 macOS SwiftBar 与 Windows 托盘，支持查看状态、启动、停止和设置间隔。
- [x] 暂停皮肤或完全恢复时停止轮换，安装/升级时不自动启用。
- [x] 补两端测试、使用说明和 changelog。

## Apply Notes
- 关联入口：macOS `menubar/`、`load-image-theme-macos.sh`；Windows `tray-dream-skin.ps1`、`theme-windows.ps1`。
- 图片按文件名顺序循环；每轮重新读取目录，少于 2 张时不切换。
- 默认 60 秒，最小 10 秒；配置写入各平台现有状态目录。
- 自动切图只更新当前主题，不新增 `themes/img-*`。
- macOS 由 SwiftBar 触发到期检查；Windows 复用托盘 `Timer`，不新增常驻 daemon。
- 损坏图片跳过；全部不可用时显示错误。macOS 停止操作等待当前切图结束。
- 不新增依赖，不修改 Codex `config.toml`、官方二进制或签名。

## Verify
- [ ] macOS 和 Windows 的竖图、方图、横图都覆盖主区域与侧边栏，控件可读可交互。
- [ ] 两端默认每 60 秒按序切图；自定义间隔持久化，非法值被拒绝。
- [ ] 图片增删在下一轮生效；少于 2 张、停止、暂停和恢复时不再切图。
- [ ] 轮换不新增已保存主题，重复启动不产生多个轮换实例。
- [ ] `cd macos && npm test` 与 `powershell -File windows/tests/run-tests.ps1` 通过。

## Status
- State: doing
- Archived: no
