/* eslint-disable react-refresh/only-export-components */
import {
  ShoppingCart, ShoppingBag, Utensils, Coffee, Pizza, Beer, Wine,
  Home, Bed, Sofa, Lightbulb, Plug, Wifi, Phone, Smartphone, Tv, Laptop,
  Car, Fuel, Bus, Train, Plane, Bike, ParkingSquare,
  Stethoscope, Pill, HeartPulse, Dumbbell,
  GraduationCap, BookOpen, Briefcase, Building2,
  PiggyBank, Landmark, CreditCard, Banknote, Wallet, Receipt,
  Gift, PartyPopper, Cake, Baby, PawPrint, Flower2, Trees,
  Wrench, Hammer, Paintbrush, Scissors, Shirt, Gem,
  Camera, Music, Film, Gamepad2, Ticket,
  Map, Mountain, Sun, Cloud, Umbrella, Snowflake, Flame, Droplet,
  Trash2, Recycle, Leaf, Heart, Star, Sparkles,
  Tag, Bookmark, Folder, Box, Package, Truck,
  HandCoins, TrendingUp, TrendingDown,
  type LucideIcon,
} from 'lucide-react'
import type { CategoryIconName } from '@cashflow/shared'
import { useCategories } from '../lib/useCategories'

export const CATEGORY_ICON_COMPONENTS: Record<CategoryIconName, LucideIcon> = {
  ShoppingCart, ShoppingBag, Utensils, Coffee, Pizza, Beer, Wine,
  Home, Bed, Sofa, Lightbulb, Plug, Wifi, Phone, Smartphone, Tv, Laptop,
  Car, Fuel, Bus, Train, Plane, Bike, ParkingSquare,
  Stethoscope, Pill, HeartPulse, Dumbbell,
  GraduationCap, BookOpen, Briefcase, Building2,
  PiggyBank, Landmark, CreditCard, Banknote, Wallet, Receipt,
  Gift, PartyPopper, Cake, Baby, PawPrint, Flower2, Trees,
  Wrench, Hammer, Paintbrush, Scissors, Shirt, Gem,
  Camera, Music, Film, Gamepad2, Ticket,
  Map, Mountain, Sun, Cloud, Umbrella, Snowflake, Flame, Droplet,
  Trash2, Recycle, Leaf, Heart, Star, Sparkles,
  Tag, Bookmark, Folder, Box, Package, Truck,
  HandCoins, TrendingUp, TrendingDown,
}

type Props = {
  name: string | null | undefined
  size?: number
  className?: string
}

export function CategoryIcon({ name, size = 16, className }: Props) {
  const { byName } = useCategories()
  if (!name) return null
  const cat = byName(name)
  const iconName = cat?.icon as CategoryIconName | null | undefined
  const Icon =
    iconName != null && iconName in CATEGORY_ICON_COMPONENTS
      ? CATEGORY_ICON_COMPONENTS[iconName]
      : Tag
  return (
    <Icon
      size={size}
      className={className}
      data-icon={iconName ?? 'Tag'}
    />
  )
}
