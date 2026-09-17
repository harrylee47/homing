# R8 混淆映射

分发出去的 `web/download/homing.apk` 是混淆过的，它的崩溃堆栈里全是
`a.b.c` 这样的名字。要还原成源码位置，必须用**与那次构建完全对应**的
`mapping.txt`——构建目录会被清掉，所以发布时要把它存进这里。

每次更新 `web/download/homing.apk` 都要同时更新这里的映射，否则
下一次收到崩溃报告时手上只有一份对不上的映射，比没有更糟。

```bash
# 构建之后
gzip -c agent/app/build/outputs/mapping/release/mapping.txt > agent/mapping/homing.apk.mapping.txt.gz

# 还原一份堆栈
gunzip -c agent/mapping/homing.apk.mapping.txt.gz > /tmp/m.txt
retrace /tmp/m.txt crash.txt        # 或 $ANDROID_HOME/cmdline-tools/latest/bin/retrace
```

对应关系靠 APK 的 sha256 记在 `SHIPPED.txt` 里，换包时一并更新。
