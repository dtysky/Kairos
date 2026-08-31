import React from 'react';
import {
  Button as AntButton,
  Card as AntCard,
  Divider,
  Modal as AntModal,
  Select as AntSelect,
  Tag,
} from 'antd';

export { Divider, Tag };

export function Button({ type = 'default', className = '', ...props }: any) {
  const isPrimary = type === 'primary';
  const danger = type === 'error';
  return (
    <AntButton
      {...props}
      danger={danger}
      type={isPrimary ? 'primary' : 'default'}
      className={`${className} kairos-button-${type}`.trim()}
    />
  );
}

export function Card(props: any) {
  return <AntCard {...props} />;
}

export function Modal({ show, cancel, actions, closeOnClickBg, showClose, children, ...props }: any) {
  return (
    <AntModal
      {...props}
      open={Boolean(show)}
      onCancel={cancel}
      footer={actions ?? null}
      closable={showClose !== false}
      maskClosable={Boolean(closeOnClickBg)}
      destroyOnHidden
    >
      {children}
    </AntModal>
  );
}

export function Select({ children, ...props }: any) {
  const { autoUpdown: _autoUpdown, maxHeight: _maxHeight, ...nextProps } = props;
  return <AntSelect {...nextProps}>{children}</AntSelect>;
}

export const Option = AntSelect.Option;
