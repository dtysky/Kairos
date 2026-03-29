# -*- coding: utf-8 -*-
"""
Author: jian wei
File Name: time_format.py
"""


def parse_start_end_format(time_range_str: str) -> str:
    """
    将 "开始时间-结束时间" 格式转换为 "开始时间-持续时间" 格式
    
    Args:
        time_range_str: 格式如 "1s-4.2s"，表示从1s开始到4.2s结束
        
    Returns:
        str: 格式如 "1s-3.2s"，表示从1s开始持续3.2s
        
    Raises:
        ValueError: 当时间格式不正确时抛出异常
    """
    if not time_range_str or "-" not in time_range_str:
        raise ValueError(f"Invalid time range format: {time_range_str}")
    
    start_str, end_str = time_range_str.split("-", 1)
    start_str = start_str.strip()
    end_str = end_str.strip()
    
    # 解析为秒数（简单解析，假设都是秒为单位）
    if not start_str.endswith('s') or not end_str.endswith('s'):
        raise ValueError(f"Time format must end with 's': {time_range_str}")
    
    try:
        start_seconds = float(start_str[:-1])
        end_seconds = float(end_str[:-1])
    except ValueError:
        raise ValueError(f"Invalid time values in: {time_range_str}")
    
    if end_seconds <= start_seconds:
        raise ValueError(f"End time must be greater than start time: {time_range_str}")
    
    duration_seconds = end_seconds - start_seconds
    
    # 格式化持续时间
    if duration_seconds == int(duration_seconds):
        duration_str = f"{int(duration_seconds)}s"
    else:
        duration_str = f"{duration_seconds}s"
    
    return f"{start_str}-{duration_str}"
