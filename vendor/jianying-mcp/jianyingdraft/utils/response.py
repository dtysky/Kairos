# -*- coding: utf-8 -*-
"""
Author: jian wei
File Name:response.py
"""
from typing import Optional, Dict, Any
from pydantic import BaseModel


class ToolResponse(BaseModel):
    """
    工具返回格式
        success: 操作是否成功
        message: 响应消息
        data: 草稿数据
    """
    success: bool
    message: str
    data: Optional[Dict[str, Any]] = None
