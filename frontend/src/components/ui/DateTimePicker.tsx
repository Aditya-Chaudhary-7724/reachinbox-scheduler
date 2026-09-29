import { Input, type InputProps } from './Input';

/** Native local date-time input (value is local time, "YYYY-MM-DDTHH:mm"). */
export function DateTimePicker(props: Omit<InputProps, 'type'>) {
  return <Input type="datetime-local" {...props} />;
}
