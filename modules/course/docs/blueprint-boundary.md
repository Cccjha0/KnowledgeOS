# 课程管理 Blueprint Boundary

## Instance boundary

One real course is one Course instance. Its `course_code`, `course_name`,
`semester`, `instructor`, and `timezone` are instance fields. Lecture,
Assignment, and Weekly Summary are the module's formal entities; there is no
separate Course record to keep in sync.

## Primary use cases

- 保存课程讲义
- 跟踪作业截止日期
- 生成每周课程总结

## Explicitly excluded

- 自动提交作业
- 自动发送邮件
- 修改用户原始课堂笔记

## Privacy contract

- Default sensitivity class: 2
- Maximum representation: full
- Network allowed: false
- User original content mutable: false

This document is generated from module.blueprint.yaml. Change the Blueprint and regenerate instead of editing this file as the design source.
