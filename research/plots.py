"""
Plotting helpers for research analysis using Matplotlib/Seaborn.
"""
from __future__ import annotations
import typing as t
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
import seaborn as sns

sns.set_context("talk")


def plot_drawdown_curve(pnl_series: pd.Series, ax: plt.Axes | None = None) -> plt.Axes:
    ax = ax or plt.gca()
    pnl = pnl_series.sort_index()
    eq = pnl.cumsum()
    roll_max = eq.cummax()
    dd = eq - roll_max
    eq.plot(ax=ax, color='steelblue', label='Equity')
    dd.plot(ax=ax, color='crimson', label='Drawdown')
    ax.legend()
    ax.set_title('Equity and Drawdown')
    return ax


def heatmap_param_response(df_grid: pd.DataFrame, x: str, y: str, z: str = 'total_net_profit', cmap: str = 'viridis', annot: bool = False) -> plt.Axes:
    pivot = df_grid.pivot_table(index=y, columns=x, values=z, aggfunc='mean')
    ax = sns.heatmap(pivot, cmap=cmap, annot=annot, fmt='.2f')
    ax.set_title(f'Response: {z} by {x} x {y}')
    return ax


def distribution_plot(df: pd.DataFrame, col: str = 'trade_net_usd') -> plt.Axes:
    ax = sns.histplot(df[col], kde=True, stat='density', bins=50)
    ax.set_title(f'Distribution: {col}')
    return ax
